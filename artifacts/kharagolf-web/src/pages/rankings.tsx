import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Trophy, Star, Users, Calendar,
  RefreshCw, Plus, Settings, ArchiveIcon, Loader2, Search,
  TrendingUp, Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { KharaGolfBrand } from "@/components/kharagolf-brand";
import { useActiveOrgContext } from "@/context/ActiveOrgContext";

const API = (path: string) => `/api${path}`;

interface RankingSeries {
  id: number;
  organizationId: number | null;
  name: string;
  description: string | null;
  level: "club" | "regional" | "national";
  status: "draft" | "active" | "archived";
  seasonStart: string;
  seasonEnd: string;
  tiebreaker: string;
  isPublic: boolean;
  createdAt: string;
}

interface RankingEntry {
  id: number;
  userId: number | null;
  playerName: string;
  category: string;
  totalPoints: number;
  eventsPlayed: number;
  wins: number;
  runnerUps: number;
  top3: number;
  position: number | null;
  profileImage?: string | null;
  displayName?: string | null;
}

interface EnrolledEvent {
  id: number;
  tournamentId: number;
  tournamentName: string;
  tournamentStatus: string;
  tournamentDate: string | null;
  category: string;
  pointsMultiplier: string;
}

interface SeriesDetail extends RankingSeries {
  pointsTable: { id: number; position: number; points: number }[];
  events: EnrolledEvent[];
}

const CATEGORY_LABELS: Record<string, string> = {
  open: "Open",
  men: "Men",
  ladies: "Ladies",
  seniors: "Seniors",
  juniors: "Juniors",
};

const LEVEL_COLORS: Record<string, string> = {
  club: "bg-green-100 text-green-800",
  regional: "bg-blue-100 text-blue-800",
  national: "bg-purple-100 text-purple-800",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  active: "bg-green-100 text-green-700",
  archived: "bg-amber-100 text-amber-700",
};

function positionMedal(pos: number | null): string {
  if (pos === 1) return "🥇";
  if (pos === 2) return "🥈";
  if (pos === 3) return "🥉";
  return pos !== null ? `#${pos}` : "-";
}

// ── Public Rankings Page ──────────────────────────────────────────────────────

export default function RankingsPage() {
  const [location] = useLocation();
  const params = new URLSearchParams(location.split("?")[1] ?? "");
  const seriesIdParam = params.get("seriesId");
  const isAdmin = location.includes("/rankings-admin");

  if (isAdmin) {
    return <AdminRankingsWrapper />;
  }

  if (seriesIdParam) {
    return <PublicStandings seriesId={parseInt(seriesIdParam)} />;
  }

  return <PublicRankingsList />;
}

function AdminRankingsWrapper() {
  const { activeOrgId } = useActiveOrgContext();
  if (!activeOrgId) {
    return (
      <div className="flex justify-center items-center h-64 text-gray-500">
        <p>No organization selected.</p>
      </div>
    );
  }
  return <AdminRankings orgId={activeOrgId} />;
}

// ── Public: List all active public series ─────────────────────────────────────

function PublicRankingsList() {
  const [series, setSeries] = useState<RankingSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();

  useEffect(() => {
    fetch(API("/public/rankings"))
      .then((r) => r.json())
      .then(setSeries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-[#1e4d2b] text-white py-12 px-4">
        <div className="max-w-5xl mx-auto">
          <KharaGolfBrand className="mb-4" variant="light" />
          <div className="flex items-center gap-3">
            <Trophy className="h-8 w-8 text-yellow-400" />
            <div>
              <h1 className="text-3xl font-bold">Rankings</h1>
              <p className="text-green-200 mt-1">National, Regional & Club Order of Merit</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : series.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <Trophy className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p className="text-lg font-medium">No active ranking series</p>
            <p className="text-sm mt-1">Check back when a series has been published.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {series.map((s) => (
              <Card
                key={s.id}
                className="p-5 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/rankings?seriesId=${s.id}`)}
              >
                <div className="flex items-start justify-between mb-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LEVEL_COLORS[s.level]}`}>
                    {s.level.charAt(0).toUpperCase() + s.level.slice(1)}
                  </span>
                  <Trophy className="h-5 w-5 text-yellow-500" />
                </div>
                <h3 className="font-semibold text-lg text-gray-900">{s.name}</h3>
                {s.description && <p className="text-sm text-gray-500 mt-1 line-clamp-2">{s.description}</p>}
                <div className="flex items-center gap-1 mt-3 text-xs text-gray-500">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>
                    {new Date(s.seasonStart).getFullYear()} season
                  </span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Public: Standings for a series ────────────────────────────────────────────

function PublicStandings({ seriesId }: { seriesId: number }) {
  const [data, setData] = useState<{ series: RankingSeries; entries: RankingEntry[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [, navigate] = useLocation();

  const load = useCallback((cat?: string) => {
    setLoading(true);
    const catParam = cat && cat !== "all" ? `?category=${cat}` : "";
    fetch(API(`/public/rankings/series/${seriesId}/standings${catParam}`))
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [seriesId]);

  useEffect(() => { load(category); }, [load, category]);

  const filtered = (data?.entries ?? []).filter((e) =>
    search === "" || e.playerName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-[#1e4d2b] text-white py-10 px-4">
        <div className="max-w-5xl mx-auto">
          <button
            onClick={() => navigate("/rankings")}
            className="text-green-200 text-sm mb-4 flex items-center gap-1 hover:text-white"
          >
            ← All Rankings
          </button>
          <div className="flex items-center gap-3">
            <Trophy className="h-7 w-7 text-yellow-400" />
            <div>
              <h1 className="text-2xl font-bold">{data?.series.name ?? "Rankings"}</h1>
              {data?.series.description && (
                <p className="text-green-200 text-sm mt-0.5">{data.series.description}</p>
              )}
            </div>
          </div>
          {data?.series && (
            <div className="flex gap-4 mt-3 text-sm text-green-200">
              <span className="capitalize">{data.series.level}</span>
              <span>·</span>
              <span>
                {new Date(data.series.seasonStart).toLocaleDateString("en", { month: "short", year: "numeric" })}
                {" – "}
                {new Date(data.series.seasonEnd).toLocaleDateString("en", { month: "short", year: "numeric" })}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search players..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-40">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <Users className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p className="font-medium">No players yet</p>
            <p className="text-sm mt-1">Standings will appear after events are completed.</p>
          </div>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3 w-12">Pos</th>
                    <th className="text-left px-4 py-3">Player</th>
                    {category === "all" && <th className="text-left px-4 py-3">Category</th>}
                    <th className="text-right px-4 py-3">Events</th>
                    <th className="text-right px-4 py-3">Wins</th>
                    <th className="text-right px-4 py-3">Top 3</th>
                    <th className="text-right px-4 py-3 font-semibold">Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((entry, idx) => (
                    <tr
                      key={entry.id}
                      className={`hover:bg-gray-50 transition-colors ${idx < 3 ? "bg-yellow-50/30" : ""}`}
                    >
                      <td className="px-4 py-3 font-semibold text-base">
                        {positionMedal(entry.position)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {entry.profileImage ? (
                            <img
                              src={entry.profileImage}
                              className="h-7 w-7 rounded-full object-cover"
                              alt=""
                            />
                          ) : (
                            <div className="h-7 w-7 rounded-full bg-[#1e4d2b] text-white text-xs flex items-center justify-center font-semibold">
                              {(entry.displayName || entry.playerName).charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className="font-medium text-gray-900">{entry.playerName}</span>
                        </div>
                      </td>
                      {category === "all" && (
                        <td className="px-4 py-3 text-gray-500">{CATEGORY_LABELS[entry.category] ?? entry.category}</td>
                      )}
                      <td className="px-4 py-3 text-right text-gray-600">{entry.eventsPlayed}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{entry.wins}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{entry.top3}</td>
                      <td className="px-4 py-3 text-right font-bold text-[#1e4d2b] text-base">
                        {entry.totalPoints}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Admin: Series management ──────────────────────────────────────────────────

function AdminRankings({ orgId }: { orgId: number }) {
  const [series, setSeries] = useState<RankingSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const { toast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    fetch(API(`/organizations/${orgId}/rankings/series`))
      .then((r) => r.json())
      .then(setSeries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  if (selectedId !== null) {
    return (
      <SeriesDetail
        orgId={orgId}
        seriesId={selectedId}
        onBack={() => { setSelectedId(null); load(); }}
      />
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Trophy className="h-6 w-6 text-[#1e4d2b]" />
          <h1 className="text-xl font-bold text-gray-900">Ranking Series</h1>
        </div>
        <Button onClick={() => setShowCreate(true)} className="bg-[#1e4d2b] hover:bg-[#163d22]">
          <Plus className="h-4 w-4 mr-2" /> New Series
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : series.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <Trophy className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p className="font-medium">No ranking series yet</p>
          <p className="text-sm mt-1">Create a series to start tracking player rankings.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {series.map((s) => (
            <Card
              key={s.id}
              className="p-5 cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => setSelectedId(s.id)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LEVEL_COLORS[s.level]}`}>
                      {s.level.charAt(0).toUpperCase() + s.level.slice(1)}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[s.status]}`}>
                      {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                    </span>
                    {!s.isPublic && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Private</span>
                    )}
                  </div>
                  <h3 className="font-semibold text-gray-900">{s.name}</h3>
                  {s.description && <p className="text-sm text-gray-500 mt-0.5">{s.description}</p>}
                  <div className="flex items-center gap-1 mt-2 text-xs text-gray-500">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>
                      {new Date(s.seasonStart).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}
                      {" – "}
                      {new Date(s.seasonEnd).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                  </div>
                </div>
                <Settings className="h-5 w-5 text-gray-400" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateSeriesDialog
          orgId={orgId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Series Detail (admin) ─────────────────────────────────────────────────────

function SeriesDetail({ orgId, seriesId, onBack }: { orgId: number; seriesId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [standings, setStandings] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [tab, setTab] = useState("standings");
  const [editOpen, setEditOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [pointsOpen, setPointsOpen] = useState(false);
  const { toast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}`)).then((r) => r.json()),
      fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/standings`)).then((r) => r.json()),
    ])
      .then(([d, s]) => {
        setDetail(d);
        setStandings(s.entries ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orgId, seriesId]);

  useEffect(() => { load(); }, [load]);

  async function handleRecalculate() {
    setRecalculating(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/recalculate`), {
        method: "POST",
      });
      const d = await r.json();
      toast({ title: `Recalculated — ${d.eventsProcessed} events processed` });
      load();
    } catch {
      toast({ title: "Recalculation failed", variant: "destructive" });
    } finally {
      setRecalculating(false);
    }
  }

  async function handleArchive() {
    if (!confirm("Archive this series? A snapshot of current standings will be saved.")) return;
    setArchiving(true);
    try {
      await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/archive`), { method: "POST" });
      toast({ title: "Series archived" });
      load();
    } catch {
      toast({ title: "Archive failed", variant: "destructive" });
    } finally {
      setArchiving(false);
    }
  }

  async function handleStatusChange(status: string) {
    await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    load();
  }

  if (loading || !detail) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-700 mb-4 flex items-center gap-1">
        ← Back to series
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LEVEL_COLORS[detail.level]}`}>
              {detail.level.charAt(0).toUpperCase() + detail.level.slice(1)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[detail.status]}`}>
              {detail.status.charAt(0).toUpperCase() + detail.status.slice(1)}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{detail.name}</h1>
          {detail.description && <p className="text-gray-500 mt-0.5">{detail.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Settings className="h-4 w-4 mr-1" /> Edit
          </Button>
          {detail.status === "draft" && (
            <Button size="sm" onClick={() => handleStatusChange("active")} className="bg-[#1e4d2b] hover:bg-[#163d22]">
              Activate
            </Button>
          )}
          {detail.status === "active" && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRecalculate}
                disabled={recalculating}
              >
                {recalculating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                Recalculate
              </Button>
              <Button variant="outline" size="sm" onClick={handleArchive} disabled={archiving}>
                {archiving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ArchiveIcon className="h-4 w-4 mr-1" />}
                Archive
              </Button>
            </>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="standings">Standings</TabsTrigger>
          <TabsTrigger value="events">Events ({detail.events.length})</TabsTrigger>
          <TabsTrigger value="points">Points Table</TabsTrigger>
        </TabsList>

        <TabsContent value="standings">
          {standings.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <TrendingUp className="h-10 w-10 mx-auto mb-2 text-gray-300" />
              <p className="font-medium">No standings yet</p>
              <p className="text-sm">Enroll events and recalculate to populate standings.</p>
            </div>
          ) : (
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase tracking-wide">
                      <th className="text-left px-4 py-3 w-12">Pos</th>
                      <th className="text-left px-4 py-3">Player</th>
                      <th className="text-left px-4 py-3">Category</th>
                      <th className="text-right px-4 py-3">Events</th>
                      <th className="text-right px-4 py-3">Wins</th>
                      <th className="text-right px-4 py-3">Top 3</th>
                      <th className="text-right px-4 py-3">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {standings.map((e) => (
                      <tr key={e.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-semibold">{positionMedal(e.position)}</td>
                        <td className="px-4 py-3 font-medium">{e.playerName}</td>
                        <td className="px-4 py-3 text-gray-500">{CATEGORY_LABELS[e.category] ?? e.category}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{e.eventsPlayed}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{e.wins}</td>
                        <td className="px-4 py-3 text-right text-gray-600">{e.top3}</td>
                        <td className="px-4 py-3 text-right font-bold text-[#1e4d2b]">{e.totalPoints}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="events">
          <div className="flex justify-end mb-3">
            <Button
              size="sm"
              onClick={() => setEnrollOpen(true)}
              className="bg-[#1e4d2b] hover:bg-[#163d22]"
            >
              <Plus className="h-4 w-4 mr-1" /> Enroll Event
            </Button>
          </div>
          {detail.events.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Calendar className="h-10 w-10 mx-auto mb-2 text-gray-300" />
              <p className="font-medium">No events enrolled</p>
              <p className="text-sm">Add tournaments to this series to track points.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {detail.events.map((ev) => (
                <Card key={ev.id} className="p-4 flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{ev.tournamentName}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                      <span>{CATEGORY_LABELS[ev.category] ?? ev.category}</span>
                      <span>·</span>
                      <span>×{ev.pointsMultiplier} multiplier</span>
                      {ev.tournamentDate && (
                        <>
                          <span>·</span>
                          <span>{new Date(ev.tournamentDate).toLocaleDateString()}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {ev.tournamentStatus}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:text-red-700"
                      onClick={async () => {
                        if (!confirm("Remove this event from the series?")) return;
                        await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/events/${ev.id}`), {
                          method: "DELETE",
                        });
                        load();
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="points">
          <div className="flex justify-end mb-3">
            <Button
              size="sm"
              onClick={() => setPointsOpen(true)}
              className="bg-[#1e4d2b] hover:bg-[#163d22]"
            >
              <Settings className="h-4 w-4 mr-1" /> Configure
            </Button>
          </div>
          {detail.pointsTable.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Star className="h-10 w-10 mx-auto mb-2 text-gray-300" />
              <p className="font-medium">No points table configured</p>
              <p className="text-sm">Set the points for each finishing position.</p>
            </div>
          ) : (
            <Card className="overflow-hidden max-w-sm">
              <div className="divide-y">
                {detail.pointsTable.map((row) => (
                  <div key={row.id} className="flex items-center justify-between px-5 py-2.5">
                    <span className="text-sm font-medium text-gray-700">
                      {positionMedal(row.position)} Position {row.position}
                    </span>
                    <span className="font-bold text-[#1e4d2b]">{row.points} pts</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {editOpen && (
        <EditSeriesDialog
          orgId={orgId}
          series={detail}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); load(); }}
        />
      )}

      {enrollOpen && (
        <EnrollEventDialog
          orgId={orgId}
          seriesId={seriesId}
          onClose={() => setEnrollOpen(false)}
          onEnrolled={() => { setEnrollOpen(false); load(); }}
        />
      )}

      {pointsOpen && (
        <PointsTableDialog
          orgId={orgId}
          seriesId={seriesId}
          existing={detail.pointsTable}
          onClose={() => setPointsOpen(false)}
          onSaved={() => { setPointsOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function CreateSeriesDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    level: "club",
    seasonStart: "",
    seasonEnd: "",
    tiebreaker: "most_wins",
    isPublic: true,
  });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  async function handleSubmit() {
    if (!form.name || !form.seasonStart || !form.seasonEnd) {
      toast({ title: "Name, start and end date are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/rankings/series`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error();
      onCreated();
    } catch {
      toast({ title: "Failed to create series", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Ranking Series</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Series Name</Label>
            <Input
              placeholder="e.g. 2025 Club Order of Merit"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              placeholder="Optional description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Level</Label>
              <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="club">Club</SelectItem>
                  <SelectItem value="regional">Regional</SelectItem>
                  <SelectItem value="national">National</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tiebreaker</Label>
              <Select value={form.tiebreaker} onValueChange={(v) => setForm({ ...form, tiebreaker: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="most_wins">Most Wins</SelectItem>
                  <SelectItem value="most_runner_up">Most Runner-ups</SelectItem>
                  <SelectItem value="most_top3">Most Top 3</SelectItem>
                  <SelectItem value="head_to_head">Head-to-Head</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Season Start</Label>
              <Input
                type="date"
                value={form.seasonStart}
                onChange={(e) => setForm({ ...form, seasonStart: e.target.value })}
              />
            </div>
            <div>
              <Label>Season End</Label>
              <Input
                type="date"
                value={form.seasonEnd}
                onChange={(e) => setForm({ ...form, seasonEnd: e.target.value })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="isPublic"
              type="checkbox"
              checked={form.isPublic}
              onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
              className="rounded"
            />
            <Label htmlFor="isPublic">Publicly visible</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving} className="bg-[#1e4d2b] hover:bg-[#163d22]">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Create Series
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditSeriesDialog({
  orgId,
  series,
  onClose,
  onSaved,
}: {
  orgId: number;
  series: RankingSeries;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: series.name,
    description: series.description ?? "",
    level: series.level,
    seasonStart: series.seasonStart.split("T")[0],
    seasonEnd: series.seasonEnd.split("T")[0],
    tiebreaker: series.tiebreaker,
    isPublic: series.isPublic,
  });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  async function handleSubmit() {
    setSaving(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/rankings/series/${series.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error();
      onSaved();
    } catch {
      toast({ title: "Failed to update series", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Series</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Series Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Level</Label>
              <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v as "club" | "regional" | "national" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="club">Club</SelectItem>
                  <SelectItem value="regional">Regional</SelectItem>
                  <SelectItem value="national">National</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tiebreaker</Label>
              <Select value={form.tiebreaker} onValueChange={(v) => setForm({ ...form, tiebreaker: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="most_wins">Most Wins</SelectItem>
                  <SelectItem value="most_runner_up">Most Runner-ups</SelectItem>
                  <SelectItem value="most_top3">Most Top 3</SelectItem>
                  <SelectItem value="head_to_head">Head-to-Head</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Season Start</Label>
              <Input type="date" value={form.seasonStart} onChange={(e) => setForm({ ...form, seasonStart: e.target.value })} />
            </div>
            <div>
              <Label>Season End</Label>
              <Input type="date" value={form.seasonEnd} onChange={(e) => setForm({ ...form, seasonEnd: e.target.value })} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="isPublicEdit"
              type="checkbox"
              checked={form.isPublic}
              onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
              className="rounded"
            />
            <Label htmlFor="isPublicEdit">Publicly visible</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving} className="bg-[#1e4d2b] hover:bg-[#163d22]">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnrollEventDialog({
  orgId,
  seriesId,
  onClose,
  onEnrolled,
}: {
  orgId: number;
  seriesId: number;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [tournaments, setTournaments] = useState<{ id: number; name: string; status: string }[]>([]);
  const [form, setForm] = useState({ tournamentId: "", category: "open", pointsMultiplier: "1.00" });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetch(API(`/organizations/${orgId}/tournaments`))
      .then((r) => r.json())
      .then((data) => setTournaments(Array.isArray(data) ? data : data.tournaments ?? []))
      .catch(() => {});
  }, [orgId]);

  async function handleSubmit() {
    if (!form.tournamentId) {
      toast({ title: "Please select a tournament", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/events`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tournamentId: parseInt(form.tournamentId),
          category: form.category,
          pointsMultiplier: parseFloat(form.pointsMultiplier),
        }),
      });
      if (!r.ok) throw new Error();
      onEnrolled();
    } catch {
      toast({ title: "Failed to enroll event", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Enroll Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Tournament</Label>
            <Select value={form.tournamentId} onValueChange={(v) => setForm({ ...form, tournamentId: v })}>
              <SelectTrigger><SelectValue placeholder="Select tournament" /></SelectTrigger>
              <SelectContent>
                {tournaments.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Points Multiplier</Label>
            <Input
              type="number"
              step="0.25"
              min="0.25"
              max="5"
              value={form.pointsMultiplier}
              onChange={(e) => setForm({ ...form, pointsMultiplier: e.target.value })}
            />
            <p className="text-xs text-gray-500 mt-1">
              Use 2.0 for double-points events, etc.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving} className="bg-[#1e4d2b] hover:bg-[#163d22]">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PointsTableDialog({
  orgId,
  seriesId,
  existing,
  onClose,
  onSaved,
}: {
  orgId: number;
  seriesId: number;
  existing: { position: number; points: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const defaultEntries = existing.length > 0
    ? existing.map((e) => ({ position: e.position, points: e.points }))
    : Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        points: [100, 75, 60, 50, 42, 36, 30, 25, 20, 15][i],
      }));

  const [entries, setEntries] = useState(defaultEntries);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  function update(idx: number, field: "position" | "points", value: number) {
    setEntries((prev) => prev.map((e, i) => i === idx ? { ...e, [field]: value } : e));
  }

  async function handleSubmit() {
    setSaving(true);
    try {
      const r = await fetch(API(`/organizations/${orgId}/rankings/series/${seriesId}/points-table`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      if (!r.ok) throw new Error();
      onSaved();
    } catch {
      toast({ title: "Failed to save points table", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Configure Points Table</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {entries.map((row, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex-1">
                <Label className="text-xs text-gray-500">Position</Label>
                <Input
                  type="number"
                  min={1}
                  value={row.position}
                  onChange={(e) => update(i, "position", parseInt(e.target.value))}
                />
              </div>
              <div className="flex-1">
                <Label className="text-xs text-gray-500">Points</Label>
                <Input
                  type="number"
                  min={0}
                  value={row.points}
                  onChange={(e) => update(i, "points", parseInt(e.target.value))}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="mt-5 text-red-400"
                onClick={() => setEntries((prev) => prev.filter((_, idx) => idx !== i))}
              >
                ×
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setEntries((prev) => [...prev, { position: prev.length + 1, points: 0 }])}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Row
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving} className="bg-[#1e4d2b] hover:bg-[#163d22]">
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
