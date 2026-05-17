import { Router, type IRouter, type Request, type Response } from "express";
import { db, pool, savedReportsTable, organizationsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { orgAdminMiddleware } from "../lib/permissions";
import PDFDocument from "pdfkit";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

/* ─── Data Source Definitions ─────────────────────────────────────────────── */

type ColumnDef = {
  key: string;
  label: string;
  sqlExpr: string;
};

type FilterDef = {
  key: string;
  label: string;
  type: "text" | "date_range" | "select" | "number_range";
  options?: { value: string; label: string }[];
  buildCondition: (value: unknown, params: unknown[]) => string;
};

type DataSourceDef = {
  label: string;
  fromClause: string;
  orgFilter: string;
  columns: ColumnDef[];
  filters: FilterDef[];
  defaultColumns: string[];
};

function addParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

const DATA_SOURCES: Record<string, DataSourceDef> = {
  tournament_players: {
    label: "Tournament Players",
    fromClause: `players p LEFT JOIN tournaments t ON t.id = p.tournament_id LEFT JOIN courses c ON c.id = t.course_id LEFT JOIN organizations o ON o.id = t.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "first_name", label: "First Name", sqlExpr: "p.first_name" },
      { key: "last_name", label: "Last Name", sqlExpr: "p.last_name" },
      { key: "email", label: "Email", sqlExpr: "p.email" },
      { key: "phone", label: "Phone", sqlExpr: "p.phone" },
      { key: "tournament_name", label: "Tournament", sqlExpr: "t.name" },
      { key: "tournament_status", label: "Tournament Status", sqlExpr: "t.status" },
      { key: "tournament_format", label: "Format", sqlExpr: "t.format" },
      { key: "start_date", label: "Start Date", sqlExpr: "TO_CHAR(t.start_date, 'YYYY-MM-DD')" },
      { key: "course_name", label: "Course", sqlExpr: "c.name" },
      { key: "handicap_index", label: "Handicap Index", sqlExpr: "p.handicap_index" },
      { key: "payment_status", label: "Payment Status", sqlExpr: "p.payment_status" },
      { key: "entry_fee", label: "Entry Fee", sqlExpr: "t.entry_fee" },
      { key: "flight", label: "Flight", sqlExpr: "p.flight" },
      { key: "tee_box", label: "Tee Box", sqlExpr: "p.tee_box" },
      { key: "checked_in", label: "Checked In", sqlExpr: "CASE WHEN p.checked_in THEN 'Yes' ELSE 'No' END" },
      { key: "registered_at", label: "Registered At", sqlExpr: "TO_CHAR(p.registered_at, 'YYYY-MM-DD HH24:MI')" },
    ],
    defaultColumns: ["first_name", "last_name", "tournament_name", "handicap_index", "payment_status"],
    filters: [
      {
        key: "tournament_status",
        label: "Tournament Status",
        type: "select",
        options: [
          { value: "draft", label: "Draft" },
          { value: "upcoming", label: "Upcoming" },
          { value: "active", label: "Active" },
          { value: "completed", label: "Completed" },
          { value: "cancelled", label: "Cancelled" },
        ],
        buildCondition: (v, params) => `t.status = ${addParam(params, v)}`,
      },
      {
        key: "payment_status",
        label: "Payment Status",
        type: "select",
        options: [
          { value: "unpaid", label: "Unpaid" },
          { value: "pending", label: "Pending" },
          { value: "paid", label: "Paid" },
          { value: "refunded", label: "Refunded" },
        ],
        buildCondition: (v, params) => `p.payment_status = ${addParam(params, v)}`,
      },
      {
        key: "date_range",
        label: "Tournament Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`t.start_date >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`t.start_date <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
      {
        key: "player_name",
        label: "Player Name",
        type: "text",
        buildCondition: (v, params) => {
          const pattern = `%${String(v)}%`;
          const p = addParam(params, pattern);
          return `(LOWER(p.first_name) LIKE LOWER(${p}) OR LOWER(p.last_name) LIKE LOWER(${p}))`;
        },
      },
    ],
  },

  league_members: {
    label: "League Members",
    fromClause: `league_members lm LEFT JOIN leagues l ON l.id = lm.league_id LEFT JOIN organizations o ON o.id = l.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "first_name", label: "First Name", sqlExpr: "lm.first_name" },
      { key: "last_name", label: "Last Name", sqlExpr: "lm.last_name" },
      { key: "email", label: "Email", sqlExpr: "lm.email" },
      { key: "league_name", label: "League", sqlExpr: "l.name" },
      { key: "league_format", label: "Format", sqlExpr: "l.format" },
      { key: "league_status", label: "League Status", sqlExpr: "l.status" },
      { key: "season_start", label: "Season Start", sqlExpr: "TO_CHAR(l.season_start, 'YYYY-MM-DD')" },
      { key: "season_end", label: "Season End", sqlExpr: "TO_CHAR(l.season_end, 'YYYY-MM-DD')" },
      { key: "handicap_index", label: "Handicap Index", sqlExpr: "lm.handicap_index" },
      { key: "payment_status", label: "Payment Status", sqlExpr: "lm.payment_status" },
      { key: "team_name", label: "Team", sqlExpr: "lm.team_name" },
      { key: "joined_at", label: "Joined At", sqlExpr: "TO_CHAR(lm.joined_at, 'YYYY-MM-DD')" },
    ],
    defaultColumns: ["first_name", "last_name", "league_name", "handicap_index", "payment_status"],
    filters: [
      {
        key: "league_status",
        label: "League Status",
        type: "select",
        options: [
          { value: "draft", label: "Draft" },
          { value: "upcoming", label: "Upcoming" },
          { value: "active", label: "Active" },
          { value: "completed", label: "Completed" },
        ],
        buildCondition: (v, params) => `l.status = ${addParam(params, v)}`,
      },
      {
        key: "payment_status",
        label: "Payment Status",
        type: "select",
        options: [
          { value: "unpaid", label: "Unpaid" },
          { value: "pending", label: "Pending" },
          { value: "paid", label: "Paid" },
          { value: "refunded", label: "Refunded" },
        ],
        buildCondition: (v, params) => `lm.payment_status = ${addParam(params, v)}`,
      },
      {
        key: "player_name",
        label: "Member Name",
        type: "text",
        buildCondition: (v, params) => {
          const pattern = `%${String(v)}%`;
          const p = addParam(params, pattern);
          return `(LOWER(lm.first_name) LIKE LOWER(${p}) OR LOWER(lm.last_name) LIKE LOWER(${p}))`;
        },
      },
      {
        key: "date_range",
        label: "Season Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`l.season_start >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`l.season_end <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
    ],
  },

  round_scores: {
    label: "Round Scores",
    fromClause: `scores s LEFT JOIN players p ON p.id = s.player_id LEFT JOIN tournaments t ON t.id = s.tournament_id LEFT JOIN courses c ON c.id = t.course_id LEFT JOIN organizations o ON o.id = t.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "first_name", label: "First Name", sqlExpr: "p.first_name" },
      { key: "last_name", label: "Last Name", sqlExpr: "p.last_name" },
      { key: "tournament_name", label: "Tournament", sqlExpr: "t.name" },
      { key: "course_name", label: "Course", sqlExpr: "c.name" },
      { key: "round", label: "Round", sqlExpr: "s.round" },
      { key: "hole_number", label: "Hole", sqlExpr: "s.hole_number" },
      { key: "strokes", label: "Strokes", sqlExpr: "s.strokes" },
      { key: "putts", label: "Putts", sqlExpr: "s.putts" },
      { key: "fairway_hit", label: "Fairway Hit", sqlExpr: "CASE WHEN s.fairway_hit THEN 'Yes' ELSE 'No' END" },
      { key: "gir_hit", label: "GIR", sqlExpr: "CASE WHEN s.gir_hit THEN 'Yes' ELSE 'No' END" },
      { key: "is_verified", label: "Verified", sqlExpr: "CASE WHEN s.is_verified THEN 'Yes' ELSE 'No' END" },
      { key: "submitted_at", label: "Submitted At", sqlExpr: "TO_CHAR(s.submitted_at, 'YYYY-MM-DD HH24:MI')" },
    ],
    defaultColumns: ["first_name", "last_name", "tournament_name", "round", "hole_number", "strokes"],
    filters: [
      {
        key: "date_range",
        label: "Tournament Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`t.start_date >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`t.start_date <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
      {
        key: "round",
        label: "Round Number",
        type: "number_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { min?: number; max?: number };
          const parts: string[] = [];
          if (val?.min != null) parts.push(`s.round >= ${addParam(params, Number(val.min))}`);
          if (val?.max != null) parts.push(`s.round <= ${addParam(params, Number(val.max))}`);
          return parts.join(" AND ") || "TRUE";
        },
      },
      {
        key: "player_name",
        label: "Player Name",
        type: "text",
        buildCondition: (v, params) => {
          const pattern = `%${String(v)}%`;
          const p = addParam(params, pattern);
          return `(LOWER(p.first_name) LIKE LOWER(${p}) OR LOWER(p.last_name) LIKE LOWER(${p}))`;
        },
      },
    ],
  },

  handicap_history: {
    label: "Handicap History",
    fromClause: `whs_postings wp LEFT JOIN players p ON p.id = wp.player_id LEFT JOIN tournaments t ON t.id = wp.tournament_id LEFT JOIN organizations o ON o.id = t.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "first_name", label: "First Name", sqlExpr: "p.first_name" },
      { key: "last_name", label: "Last Name", sqlExpr: "p.last_name" },
      { key: "ghin_number", label: "GHIN Number", sqlExpr: "wp.ghin_number" },
      { key: "tournament_name", label: "Tournament", sqlExpr: "t.name" },
      { key: "round", label: "Round", sqlExpr: "wp.round" },
      { key: "gross_score", label: "Gross Score", sqlExpr: "wp.gross_score" },
      { key: "adjusted_gross_score", label: "Adjusted Gross Score", sqlExpr: "wp.adjusted_gross_score" },
      { key: "course_rating", label: "Course Rating", sqlExpr: "wp.course_rating" },
      { key: "slope", label: "Slope", sqlExpr: "wp.slope" },
      { key: "status", label: "Posting Status", sqlExpr: "wp.status" },
      { key: "posted_at", label: "Posted At", sqlExpr: "TO_CHAR(wp.posted_at, 'YYYY-MM-DD')" },
    ],
    defaultColumns: ["first_name", "last_name", "tournament_name", "gross_score", "adjusted_gross_score", "status"],
    filters: [
      {
        key: "status",
        label: "Posting Status",
        type: "select",
        options: [
          { value: "pending", label: "Pending" },
          { value: "posted", label: "Posted" },
          { value: "failed", label: "Failed" },
          { value: "no_ghin", label: "No GHIN" },
        ],
        buildCondition: (v, params) => `wp.status = ${addParam(params, v)}`,
      },
      {
        key: "date_range",
        label: "Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`wp.posted_at >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`wp.posted_at <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
      {
        key: "player_name",
        label: "Player Name",
        type: "text",
        buildCondition: (v, params) => {
          const pattern = `%${String(v)}%`;
          const p = addParam(params, pattern);
          return `(LOWER(p.first_name) LIKE LOWER(${p}) OR LOWER(p.last_name) LIKE LOWER(${p}))`;
        },
      },
    ],
  },

  membership_payments: {
    label: "Membership Payments",
    fromClause: `(
      SELECT p.first_name, p.last_name, p.email, p.phone,
        t.name AS source_name, 'Tournament' AS source_type,
        p.payment_status, t.entry_fee AS fee, t.currency,
        p.registered_at AS payment_date, t.organization_id
      FROM players p JOIN tournaments t ON t.id = p.tournament_id
      UNION ALL
      SELECT lm.first_name, lm.last_name, lm.email, NULL AS phone,
        l.name AS source_name, 'League' AS source_type,
        lm.payment_status, l.entry_fee AS fee, l.currency,
        lm.joined_at AS payment_date, l.organization_id
      FROM league_members lm JOIN leagues l ON l.id = lm.league_id
    ) mp JOIN organizations o ON o.id = mp.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "first_name", label: "First Name", sqlExpr: "mp.first_name" },
      { key: "last_name", label: "Last Name", sqlExpr: "mp.last_name" },
      { key: "email", label: "Email", sqlExpr: "mp.email" },
      { key: "source_type", label: "Type", sqlExpr: "mp.source_type" },
      { key: "source_name", label: "Event/League", sqlExpr: "mp.source_name" },
      { key: "payment_status", label: "Payment Status", sqlExpr: "mp.payment_status" },
      { key: "fee", label: "Fee", sqlExpr: "mp.fee" },
      { key: "currency", label: "Currency", sqlExpr: "mp.currency" },
      { key: "payment_date", label: "Date", sqlExpr: "TO_CHAR(mp.payment_date, 'YYYY-MM-DD')" },
    ],
    defaultColumns: ["first_name", "last_name", "source_type", "source_name", "payment_status", "fee"],
    filters: [
      {
        key: "payment_status",
        label: "Payment Status",
        type: "select",
        options: [
          { value: "unpaid", label: "Unpaid" },
          { value: "pending", label: "Pending" },
          { value: "paid", label: "Paid" },
          { value: "refunded", label: "Refunded" },
        ],
        buildCondition: (v, params) => `mp.payment_status = ${addParam(params, v)}`,
      },
      {
        key: "source_type",
        label: "Source Type",
        type: "select",
        options: [
          { value: "Tournament", label: "Tournament" },
          { value: "League", label: "League" },
        ],
        buildCondition: (v, params) => `mp.source_type = ${addParam(params, v)}`,
      },
      {
        key: "date_range",
        label: "Payment Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`mp.payment_date >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`mp.payment_date <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
      {
        key: "player_name",
        label: "Player Name",
        type: "text",
        buildCondition: (v, params) => {
          const pattern = `%${String(v)}%`;
          const p = addParam(params, pattern);
          return `(LOWER(mp.first_name) LIKE LOWER(${p}) OR LOWER(mp.last_name) LIKE LOWER(${p}))`;
        },
      },
    ],
  },

  shop_orders: {
    label: "Shop Orders",
    fromClause: `shop_orders so LEFT JOIN organizations o ON o.id = so.organization_id`,
    orgFilter: "o.id",
    columns: [
      { key: "order_number", label: "Order #", sqlExpr: "so.id" },
      { key: "customer_name", label: "Customer Name", sqlExpr: "so.customer_name" },
      { key: "customer_email", label: "Customer Email", sqlExpr: "so.customer_email" },
      { key: "customer_phone", label: "Customer Phone", sqlExpr: "so.customer_phone" },
      { key: "status", label: "Status", sqlExpr: "so.status" },
      { key: "quantity", label: "Quantity", sqlExpr: "so.quantity" },
      { key: "unit_price", label: "Unit Price", sqlExpr: "so.unit_price" },
      { key: "total_amount", label: "Total", sqlExpr: "so.total_amount" },
      { key: "currency", label: "Currency", sqlExpr: "so.currency" },
      { key: "tracking_number", label: "Tracking #", sqlExpr: "so.tracking_number" },
      { key: "created_at", label: "Order Date", sqlExpr: "TO_CHAR(so.created_at, 'YYYY-MM-DD')" },
    ],
    defaultColumns: ["order_number", "customer_name", "total_amount", "status", "created_at"],
    filters: [
      {
        key: "status",
        label: "Order Status",
        type: "select",
        options: [
          { value: "pending", label: "Pending" },
          { value: "confirmed", label: "Confirmed" },
          { value: "completed", label: "Completed" },
          { value: "cancelled", label: "Cancelled" },
          { value: "refunded", label: "Refunded" },
        ],
        buildCondition: (v, params) => `so.status = ${addParam(params, v)}`,
      },
      {
        key: "date_range",
        label: "Order Date Range",
        type: "date_range",
        buildCondition: (v: unknown, params) => {
          const val = v as { from?: string; to?: string };
          const parts: string[] = [];
          if (val?.from) parts.push(`so.created_at >= ${addParam(params, val.from)}::date`);
          if (val?.to) parts.push(`so.created_at <= ${addParam(params, val.to)}::date`);
          return parts.join(" AND ") || "TRUE";
        },
      },
    ],
  },
};

/* ─── Parameterized Query Builder ─────────────────────────────────────────── */

interface ReportConfig {
  dataSource: string;
  columns: { key: string; label: string }[];
  filters: Record<string, unknown>;
  sortConfig?: { column: string; direction: "asc" | "desc" } | null;
}

interface BuiltQuery {
  text: string;
  values: unknown[];
  countText: string;
  countValues: unknown[];
  effectiveCols: { key: string; label: string }[];
}

function buildQuery(orgId: number, config: ReportConfig, limit?: number, offset?: number): BuiltQuery {
  const ds = DATA_SOURCES[config.dataSource];
  if (!ds) throw new Error(`Unknown data source: ${config.dataSource}`);

  const allColDefs = ds.columns;
  const validColKeys = new Set(allColDefs.map(c => c.key));

  const requestedCols = config.columns.length > 0 ? config.columns : allColDefs.filter(c => ds.defaultColumns.includes(c.key));
  if (requestedCols.length === 0) throw new Error("No columns selected");

  for (const col of requestedCols) {
    if (!validColKeys.has(col.key)) throw new Error(`Invalid column: ${col.key}`);
  }

  const effectiveCols = requestedCols;
  const selectParts = effectiveCols.map(col => {
    const def = allColDefs.find(c => c.key === col.key)!;
    return `${def.sqlExpr} AS "${col.key}"`;
  });

  const params: unknown[] = [];
  params.push(orgId);
  const whereParts: string[] = [`${ds.orgFilter} = $1`];

  for (const [filterKey, filterValue] of Object.entries(config.filters)) {
    if (filterValue == null || filterValue === "" || filterValue === "_any_") continue;
    if (typeof filterValue === "object" && !Array.isArray(filterValue)) {
      const v = filterValue as Record<string, unknown>;
      if (!v.from && !v.to && v.min == null && v.max == null) continue;
    }
    const filterDef = ds.filters.find(f => f.key === filterKey);
    if (!filterDef) continue;
    const cond = filterDef.buildCondition(filterValue, params);
    if (cond && cond !== "TRUE") whereParts.push(`(${cond})`);
  }

  const whereClause = `WHERE ${whereParts.join(" AND ")}`;

  let orderBy = "";
  if (config.sortConfig?.column) {
    if (validColKeys.has(config.sortConfig.column)) {
      const def = allColDefs.find(c => c.key === config.sortConfig!.column)!;
      const dir = config.sortConfig.direction === "desc" ? "DESC" : "ASC";
      orderBy = `ORDER BY ${def.sqlExpr} ${dir}`;
    }
  }

  const dataParams = [...params];
  const limitClause = limit != null ? `LIMIT $${dataParams.push(limit)}` : "";
  const offsetClause = offset != null ? `OFFSET $${dataParams.push(offset)}` : "";

  const text = `SELECT ${selectParts.join(", ")} FROM ${ds.fromClause} ${whereClause} ${orderBy} ${limitClause} ${offsetClause}`.trim();
  const countText = `SELECT COUNT(*) AS total FROM ${ds.fromClause} ${whereClause}`;

  return { text, values: dataParams, countText, countValues: params, effectiveCols };
}

/* ─── Standard Templates ───────────────────────────────────────────────────── */

const STANDARD_TEMPLATES: Omit<typeof savedReportsTable.$inferInsert, "organizationId" | "createdByUserId" | "createdAt" | "updatedAt">[] = [
  {
    name: "Season Payments Summary",
    description: "Overview of all payment statuses across tournaments and leagues",
    dataSource: "membership_payments",
    columns: [
      { key: "first_name", label: "First Name" },
      { key: "last_name", label: "Last Name" },
      { key: "source_type", label: "Type" },
      { key: "source_name", label: "Event/League" },
      { key: "payment_status", label: "Payment Status" },
      { key: "fee", label: "Fee" },
      { key: "currency", label: "Currency" },
    ],
    filters: {},
    sortConfig: { column: "payment_status", direction: "asc" },
    isTemplate: true,
  },
  {
    name: "Active Members List",
    description: "All active league members with handicap information",
    dataSource: "league_members",
    columns: [
      { key: "first_name", label: "First Name" },
      { key: "last_name", label: "Last Name" },
      { key: "email", label: "Email" },
      { key: "league_name", label: "League" },
      { key: "handicap_index", label: "Handicap Index" },
      { key: "payment_status", label: "Payment Status" },
      { key: "joined_at", label: "Joined At" },
    ],
    filters: { league_status: "active" },
    sortConfig: { column: "last_name", direction: "asc" },
    isTemplate: true,
  },
  {
    name: "Tournament Results Archive",
    description: "All completed tournament players with registration details",
    dataSource: "tournament_players",
    columns: [
      { key: "first_name", label: "First Name" },
      { key: "last_name", label: "Last Name" },
      { key: "tournament_name", label: "Tournament" },
      { key: "start_date", label: "Date" },
      { key: "tournament_format", label: "Format" },
      { key: "handicap_index", label: "HCP" },
      { key: "payment_status", label: "Payment" },
    ],
    filters: { tournament_status: "completed" },
    sortConfig: { column: "start_date", direction: "desc" },
    isTemplate: true,
  },
  {
    name: "Handicap Movements",
    description: "WHS score postings showing gross and adjusted scores",
    dataSource: "handicap_history",
    columns: [
      { key: "first_name", label: "First Name" },
      { key: "last_name", label: "Last Name" },
      { key: "ghin_number", label: "GHIN" },
      { key: "tournament_name", label: "Tournament" },
      { key: "gross_score", label: "Gross" },
      { key: "adjusted_gross_score", label: "Adjusted Gross" },
      { key: "course_rating", label: "CR" },
      { key: "slope", label: "Slope" },
      { key: "status", label: "Status" },
    ],
    filters: {},
    sortConfig: { column: "posted_at", direction: "desc" },
    isTemplate: true,
  },
];

async function ensureTemplatesForOrg(orgId: number): Promise<void> {
  const existing = await db
    .select({ id: savedReportsTable.id })
    .from(savedReportsTable)
    .where(and(eq(savedReportsTable.organizationId, orgId), eq(savedReportsTable.isTemplate, true)));

  if (existing.length >= STANDARD_TEMPLATES.length) return;

  for (const tpl of STANDARD_TEMPLATES) {
    await db.insert(savedReportsTable).values({
      organizationId: orgId,
      ...tpl,
    }).onConflictDoNothing();
  }
}

/* ─── Routes ─────────────────────────────────────────────────────────────── */

router.get("/schema", orgAdminMiddleware, async (req: Request, res: Response) => {
  const schema = Object.entries(DATA_SOURCES).map(([key, ds]) => ({
    key,
    label: ds.label,
    columns: ds.columns.map(c => ({ key: c.key, label: c.label })),
    filters: ds.filters.map(f => ({ key: f.key, label: f.label, type: f.type, options: f.options })),
    defaultColumns: ds.defaultColumns,
  }));
  res.json(schema);
});

router.get("/", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  await ensureTemplatesForOrg(orgId);
  const reports = await db
    .select()
    .from(savedReportsTable)
    .where(eq(savedReportsTable.organizationId, orgId))
    .orderBy(sql`${savedReportsTable.isTemplate} DESC, ${savedReportsTable.createdAt} DESC`);
  res.json(reports);
});

router.post("/", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, description, dataSource, columns, filters, sortConfig } = req.body;

  if (!name || !dataSource) { { res.status(400).json({ error: "name and dataSource are required" }); return; } }
  if (!DATA_SOURCES[dataSource]) { { res.status(400).json({ error: "Invalid data source" }); return; } }

  const [report] = await db.insert(savedReportsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    dataSource,
    columns: columns ?? [],
    filters: filters ?? {},
    sortConfig: sortConfig ?? null,
    isTemplate: false,
    createdByUserId: (req as unknown as { user?: { id: number } }).user?.id ?? null,
  }).returning();

  res.status(201).json(report);
});

router.get("/:reportId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));
  const [report] = await db.select().from(savedReportsTable)
    .where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId)));
  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }
  res.json(report);
});

router.put("/:reportId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));
  const { name, description, dataSource, columns, filters, sortConfig } = req.body;

  if (dataSource && !DATA_SOURCES[dataSource]) { { res.status(400).json({ error: "Invalid data source" }); return; } }

  const [report] = await db.update(savedReportsTable).set({
    ...(name ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(dataSource ? { dataSource } : {}),
    ...(columns ? { columns } : {}),
    ...(filters ? { filters } : {}),
    ...(sortConfig !== undefined ? { sortConfig } : {}),
    updatedAt: new Date(),
  }).where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId))).returning();

  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }
  res.json(report);
});

router.delete("/:reportId", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));
  await db.delete(savedReportsTable)
    .where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId)));
  res.status(204).send();
});

router.post("/run", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { dataSource, columns, filters, sortConfig, page = 1, pageSize = 50 } = req.body;

  if (!dataSource || !DATA_SOURCES[dataSource]) { { res.status(400).json({ error: "Valid dataSource is required" }); return; } }

  try {
    const pageNum = Math.max(1, parseInt(String(page)));
    const size = Math.min(200, Math.max(1, parseInt(String(pageSize))));
    const offset = (pageNum - 1) * size;

    const config: ReportConfig = { dataSource, columns: columns ?? [], filters: filters ?? {}, sortConfig };
    const built = buildQuery(orgId, config, size, offset);

    const [rows, countResult] = await Promise.all([
      pool.query(built.text, built.values),
      pool.query(built.countText, built.countValues),
    ]);

    const total = parseInt(String(countResult.rows[0]?.total ?? 0));
    res.json({ rows: rows.rows, total, page: pageNum, pageSize: size, totalPages: Math.ceil(total / size) });
  } catch (err) {
    logger.error({ err }, "[reports] Ad-hoc run failed");
    res.status(400).json({ error: err instanceof Error ? err.message : "Query failed" });
  }
});

router.post("/:reportId/run", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));
  const { page = 1, pageSize = 50, filters: overrideFilters } = req.body;

  const [report] = await db.select().from(savedReportsTable)
    .where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId)));
  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }

  try {
    const pageNum = Math.max(1, parseInt(String(page)));
    const size = Math.min(200, Math.max(1, parseInt(String(pageSize))));
    const offset = (pageNum - 1) * size;

    const config: ReportConfig = {
      dataSource: report.dataSource,
      columns: (report.columns as { key: string; label: string }[]) ?? [],
      filters: { ...(report.filters as Record<string, unknown>), ...(overrideFilters ?? {}) },
      sortConfig: report.sortConfig as { column: string; direction: "asc" | "desc" } | null,
    };

    const built = buildQuery(orgId, config, size, offset);
    const [rows, countResult] = await Promise.all([
      pool.query(built.text, built.values),
      pool.query(built.countText, built.countValues),
    ]);
    const total = parseInt(String(countResult.rows[0]?.total ?? 0));
    res.json({ rows: rows.rows, total, page: pageNum, pageSize: size, totalPages: Math.ceil(total / size) });
  } catch (err) {
    logger.error({ err, reportId }, "[reports] Saved report run failed");
    res.status(400).json({ error: err instanceof Error ? err.message : "Query failed" });
  }
});

// CSV streaming export — uses a pg cursor-style approach (rows streamed chunk by chunk)
router.get("/:reportId/csv", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));

  const [report] = await db.select().from(savedReportsTable)
    .where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId)));
  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }

  try {
    const config: ReportConfig = {
      dataSource: report.dataSource,
      columns: (report.columns as { key: string; label: string }[]) ?? [],
      filters: (report.filters as Record<string, unknown>) ?? {},
      sortConfig: report.sortConfig as { column: string; direction: "asc" | "desc" } | null,
    };

    const built = buildQuery(orgId, config);
    const filename = `${report.name.replace(/[^a-zA-Z0-9]/g, "_")}_${new Date().toISOString().split("T")[0]}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    const escapeCsv = (val: unknown): string => {
      if (val == null) return "";
      const s = String(val);
      return (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r"))
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const headers = built.effectiveCols.map(c => escapeCsv(c.label)).join(",");
    res.write(headers + "\n");

    // Stream rows in 500-row pages to avoid memory bloat
    const PAGE_SIZE = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const pagedBuilt = buildQuery(orgId, config, PAGE_SIZE, offset);
      const result = await pool.query(pagedBuilt.text, pagedBuilt.values);
      if (result.rows.length === 0) { hasMore = false; break; }

      for (const row of result.rows) {
        const r = row as Record<string, unknown>;
        const line = built.effectiveCols.map(c => escapeCsv(r[c.key])).join(",");
        res.write(line + "\n");
      }

      hasMore = result.rows.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }

    res.end();
  } catch (err) {
    logger.error({ err, reportId }, "[reports] CSV export failed");
    if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : "Export failed" });
    else res.end();
  }
});

router.get("/:reportId/pdf", orgAdminMiddleware, async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reportId = parseInt(String((req.params as Record<string, string>).reportId));

  const [report] = await db.select().from(savedReportsTable)
    .where(and(eq(savedReportsTable.id, reportId), eq(savedReportsTable.organizationId, orgId)));
  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  try {
    const config: ReportConfig = {
      dataSource: report.dataSource,
      columns: (report.columns as { key: string; label: string }[]) ?? [],
      filters: (report.filters as Record<string, unknown>) ?? {},
      sortConfig: report.sortConfig as { column: string; direction: "asc" | "desc" } | null,
    };

    const built = buildQuery(orgId, config, 1000);
    const result = await pool.query(built.text, built.values);

    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    const filename = `${report.name.replace(/[^a-zA-Z0-9]/g, "_")}_${new Date().toISOString().split("T")[0]}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    const primaryColor = org?.primaryColor ?? "#1e4d2b";
    const pageWidth = doc.page.width - 80;
    const colWidth = Math.min(120, pageWidth / built.effectiveCols.length);

    doc.rect(40, 40, pageWidth, 40).fill(primaryColor);
    doc.fill("white").fontSize(16).font("Helvetica-Bold").text(report.name, 50, 50, { width: pageWidth - 100 });
    doc.fill("#666").fontSize(9).font("Helvetica").text(`${org?.name ?? "KHARAGOLF"} • Generated ${new Date().toLocaleDateString()}`, 50, 68);

    let y = 100;
    doc.rect(40, y, pageWidth, 18).fill("#f5f5f5");
    let x = 40;
    for (const col of built.effectiveCols) {
      doc.fill("#333").fontSize(7).font("Helvetica-Bold").text(col.label, x + 3, y + 5, { width: colWidth - 6, ellipsis: true });
      x += colWidth;
    }
    y += 18;

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i] as Record<string, unknown>;
      if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
      if (i % 2 === 0) doc.rect(40, y, pageWidth, 15).fill("#fafafa");
      x = 40;
      for (const col of built.effectiveCols) {
        doc.fill("#444").fontSize(7).font("Helvetica").text(row[col.key] == null ? "" : String(row[col.key]), x + 3, y + 4, { width: colWidth - 6, ellipsis: true });
        x += colWidth;
      }
      y += 15;
    }

    doc.fill("#999").fontSize(7).text(`${result.rows.length} record(s)`, 40, doc.page.height - 30, { width: pageWidth, align: "right" });
    doc.end();
  } catch (err) {
    logger.error({ err, reportId }, "[reports] PDF export failed");
    if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : "Export failed" });
  }
});

export default router;
