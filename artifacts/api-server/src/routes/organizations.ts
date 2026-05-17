import { Router, type IRouter, type Request, type Response } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import {
  organizationsTable, appUsersTable, orgMembershipsTable,
  tournamentsTable, playersTable, scoresTable, holeDetailsTable, coursesTable, leaguesTable, leagueMembersTable, leagueStandingsTable,
  orgGhinCredentialsTable,
  bouncedDigestScheduleOptOutsTable,
  bouncedDigestScheduleSendsTable,
  roundRobinTieBreakEmailOptOutsTable,
  tournamentNotificationOverrideAuditTable,
} from "@workspace/db";
import { eq, count, sql, isNull, and, or, desc, asc, inArray, isNotNull, lte } from "drizzle-orm";
import { encrypt, decrypt, isEncrypted, encryptionAvailable } from "../lib/crypto";
import { getOrgPlanStatus, gateBranding, gateAdvancedAnalytics } from "../lib/featureGate";
import { TIER_DISPLAY, TIER_LIMITS, getTierDisplay, isSubscriptionTier, type SubscriptionTier } from "../lib/subscriptionTiers";
import { resolveGhinCredentials } from "../lib/ghin";
import {
  sendBouncedLevyDigestEmail,
  sendBouncedDigestScheduleChangedEmail,
  sendCustomDomainHttpsActiveEmail,
  sendCustomDomainHttpsFailedEmail,
} from "../lib/mailer";
import { getBouncedLeviesForOrg } from "../lib/levyBouncedReminders";
import { logger } from "../lib/logger";
import { signBouncedDigestScheduleOptOutToken } from "../lib/bouncedDigestUnsubscribe";
import {
  notifyBouncedDigestScheduleAdminResubscribed,
  notifyTieBreakAdminResubscribed,
} from "../lib/adminResubscribeNotify";
import { getIngressClient, type CertStatus } from "../lib/ingressClient";
import {
  ORG_NOTIFICATION_DEFAULT_SPECS,
  isOrgNotificationDefaultKey,
  type OrgNotificationDefaultKey,
} from "../lib/orgNotificationDefaults";
import {
  listManualEntryAlertRows,
  parseManualEntryAlertRowsQuery,
} from "../lib/manualEntryAlertHealth";
import { dispatchNotification } from "../lib/notifyDispatch";

const router: IRouter = Router();

/**
 * Task #663 — Normalise a custom-domain value before storing it on the
 * organisation row. Trims whitespace, lowercases, strips an accidentally
 * pasted protocol/path/port. Returns:
 *   - `undefined` when the caller didn't include the field at all
 *     (so we leave the existing value untouched)
 *   - `null` when the caller explicitly cleared it (or sent something
 *     non-string-y)
 *   - the cleaned hostname otherwise
 *
 * Done so a club admin pasting " Golf.YourClub.com " or
 * "https://golf.yourclub.com/" can't end up with a row that the
 * by-host lookup silently fails to match at request time.
 */
function normalizeCustomDomainForStorage(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return null;
  const cleaned = v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return cleaned === "" ? null : cleaned;
}

// Authorization guard: caller must be authenticated AND be an org_admin,
// tournament_director, or platform super_admin for the given org.
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  if (req.user!.role === "super_admin") return true;
  if ((req.user!.role === "org_admin" || req.user!.role === "tournament_director") && Number((req.user! as unknown as AuthUser).organizationId) === orgId) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, req.user!.id),
    ));

  if (!membership || !["org_admin", "tournament_director"].includes(membership.role)) {
    res.status(403).json({ error: "You do not have admin access to this organization." });
    return false;
  }
  return true;
}

// GET /organizations
router.get("/", async (req: Request, res: Response) => {
  const orgs = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      description: organizationsTable.description,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      customDomain: organizationsTable.customDomain,
      subscriptionTier: organizationsTable.subscriptionTier,
      isActive: organizationsTable.isActive,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .orderBy(organizationsTable.name);

  const results = await Promise.all(
    orgs.map(async (org) => {
      const [memberCount] = await db
        .select({ count: count() })
        .from(orgMembershipsTable)
        .where(eq(orgMembershipsTable.organizationId, org.id));
      const [tournamentCount] = await db
        .select({ count: count() })
        .from(tournamentsTable)
        .where(eq(tournamentsTable.organizationId, org.id));
      return {
        ...org,
        memberCount: Number(memberCount?.count ?? 0),
        tournamentCount: Number(tournamentCount?.count ?? 0),
      };
    }),
  );

  res.json(results);
});

// POST /organizations
router.post("/", async (req: Request, res: Response) => {
  const { name, slug, description, logoUrl, primaryColor, customDomain, subscriptionTier } = req.body;

  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }

  if (subscriptionTier != null && !isSubscriptionTier(subscriptionTier)) {
    res.status(400).json({ error: "Invalid subscription tier. Must be one of: free, starter, pro, enterprise" });
    return;
  }
  const tier: SubscriptionTier = isSubscriptionTier(subscriptionTier) ? subscriptionTier : "free";

  // Task #663 — normalise so the by-host lookup matches at request time.
  const normalizedDomain = normalizeCustomDomainForStorage(customDomain);

  const [org] = await db
    .insert(organizationsTable)
    .values({
      name,
      slug,
      description,
      logoUrl,
      primaryColor,
      customDomain: normalizedDomain ?? null,
      subscriptionTier: tier,
    })
    .returning();

  res.status(201).json({ ...org, memberCount: 0, tournamentCount: 0 });
});

// GET /organizations/:orgId
router.get("/:orgId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const [memberCount] = await db.select({ count: count() }).from(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  const [tournamentCount] = await db.select({ count: count() }).from(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));

  res.json({ ...org, memberCount: Number(memberCount?.count ?? 0), tournamentCount: Number(tournamentCount?.count ?? 0) });
});

// PUT /organizations/:orgId
router.put("/:orgId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, slug, description, logoUrl, primaryColor, customDomain, subscriptionTier } = req.body;

  if (subscriptionTier !== undefined && !isSubscriptionTier(subscriptionTier)) {
    res.status(400).json({ error: "Invalid subscription tier. Must be one of: free, starter, pro, enterprise" });
    return;
  }

  // Task #663 — normalise so the by-host lookup matches at request time.
  const normalizedDomain = normalizeCustomDomainForStorage(customDomain);
  const updateValues: Record<string, unknown> = {
    name, slug, description, logoUrl, primaryColor, subscriptionTier, updatedAt: new Date(),
  };
  if (normalizedDomain !== undefined) updateValues.customDomain = normalizedDomain;

  const [org] = await db
    .update(organizationsTable)
    .set(updateValues)
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json({ ...org, memberCount: 0, tournamentCount: 0 });
});

// PATCH /organizations/:orgId/contact — update club contact details
router.patch("/:orgId/contact", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { contactEmail, contactPhone, address, website } = req.body;
  const [org] = await db
    .update(organizationsTable)
    .set({ contactEmail, contactPhone, address, website, updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json(org);
});

// Task #362 — GET /organizations/:orgId/rules-config
// Returns the club's Rules Assistant configuration (governing-body wording
// + local-rules markdown). Restricted to members of the same org (or super
// admins) since local rules are internal club policy.
router.get("/:orgId/rules-config", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  const u = req.user! as unknown as AuthUser;
  const isSuperAdmin = u.role === "super_admin";
  if (!isSuperAdmin && Number(u.organizationId) !== orgId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [org] = await db
    .select({
      name: organizationsTable.name,
      rulesGoverningBody: organizationsTable.rulesGoverningBody,
      localRulesContent: organizationsTable.localRulesContent,
      logoUrl: organizationsTable.logoUrl,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json({
    organizationName: org.name,
    rulesGoverningBody: org.rulesGoverningBody,
    localRulesContent: org.localRulesContent ?? "",
    logoUrl: org.logoUrl ?? null,
  });
});

// Task #362 — PATCH /organizations/:orgId/rules-config
// Org admin saves the governing-body variant + local-rules markdown.
const RULES_GOVERNING_BODIES = new Set(["rna", "usga"]);
const LOCAL_RULES_MAX_CHARS = 20_000;
router.patch("/:orgId/rules-config", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = req.body as { rulesGoverningBody?: unknown; localRulesContent?: unknown };
  const variant = typeof body.rulesGoverningBody === "string" ? body.rulesGoverningBody : "";
  if (!RULES_GOVERNING_BODIES.has(variant)) {
    res.status(400).json({ error: "rulesGoverningBody must be 'rna' or 'usga'." });
    return;
  }
  let localRules: string | null = null;
  if (body.localRulesContent !== undefined && body.localRulesContent !== null) {
    if (typeof body.localRulesContent !== "string") {
      res.status(400).json({ error: "localRulesContent must be a string." });
      return;
    }
    if (body.localRulesContent.length > LOCAL_RULES_MAX_CHARS) {
      res.status(400).json({ error: `localRulesContent exceeds ${LOCAL_RULES_MAX_CHARS} characters.` });
      return;
    }
    const trimmed = body.localRulesContent.trim();
    localRules = trimmed.length === 0 ? null : trimmed;
  }

  const [org] = await db
    .update(organizationsTable)
    .set({
      rulesGoverningBody: variant as "rna",
      localRulesContent: localRules,
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId))
    .returning({
      rulesGoverningBody: organizationsTable.rulesGoverningBody,
      localRulesContent: organizationsTable.localRulesContent,
    });
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json({
    rulesGoverningBody: org.rulesGoverningBody,
    localRulesContent: org.localRulesContent ?? "",
  });
});

// Task #1188 / #1379 / #1673 — Org-wide notification-defaults endpoints.
//
// All four endpoints below are driven by `ORG_NOTIFICATION_DEFAULT_SPECS`
// (see `lib/orgNotificationDefaults.ts`). Each spec maps a wire key to a
// pair of drizzle columns (org-wide value + per-tournament override).
// Adding a new org-wide notification default means appending one entry
// to that registry and the GET/PATCH/list/apply endpoints all pick it up
// automatically — no bespoke endpoint pair per flag.
//
// All four are org_admin only — this is a settings page, not user-facing.
//
// "Still-relevant tournament" filter (used by the list + apply endpoints):
//   status in (draft, upcoming, active, suspended). Completed and
//   cancelled events never fire these alerts again so dragging them into
//   the view would just be noise.

const RELEVANT_TOURNAMENT_STATUSES = ["draft", "upcoming", "active", "suspended"] as const;

// GET /organizations/:orgId/notification-defaults
// Returns one boolean per registered key. Shape stays object-of-keys so
// the web client can spread the response straight into local state.
router.get("/:orgId/notification-defaults", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  // Build a dynamic projection over the registered columns. Drizzle's
  // `.select()` returns `unknown[]` rows when handed an arbitrary record;
  // we cast the row to a string-keyed boolean map at the response edge.
  const projection: Record<string, unknown> = {};
  for (const spec of ORG_NOTIFICATION_DEFAULT_SPECS) {
    projection[spec.key] = spec.orgColumn;
  }
  const [org] = await db.select(projection as Record<string, never>)
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json(org);
});

// PATCH /organizations/:orgId/notification-defaults
// Accepts any subset of registered keys; unknown keys are rejected so we
// don't silently swallow typos (which historically caused tasks like
// #1188 to ship as no-ops in staging). Each key must be a boolean.
// Existing tournament rows are intentionally left untouched so a TD that
// has previously flipped the per-tournament toggle keeps their override —
// admins use POST .../apply-to-tournaments to bulk-overwrite.
router.patch("/:orgId/notification-defaults", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  const returning: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (!isOrgNotificationDefaultKey(key)) {
      res.status(400).json({ error: `Unknown notification default: ${key}` });
      return;
    }
    if (typeof value !== "boolean") {
      res.status(400).json({ error: `${key} must be a boolean` });
      return;
    }
    const spec = ORG_NOTIFICATION_DEFAULT_SPECS.find(s => s.key === key)!;
    updates[key] = value;
    returning[key] = spec.orgColumn;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No supported fields provided" });
    return;
  }
  updates.updatedAt = new Date();

  const [org] = await db
    .update(organizationsTable)
    .set(updates as Record<string, never>)
    .where(eq(organizationsTable.id, orgId))
    .returning(returning as Record<string, never>);
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json(org);
});

// GET /organizations/:orgId/notification-defaults/tournaments
// Returns every still-relevant tournament with its current value for each
// registered per-tournament toggle. The web client pre-computes the
// inheritance summary ("X of Y match the club default") for each toggle
// from this single payload so the page only does one round trip.
router.get("/:orgId/notification-defaults/tournaments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const projection: Record<string, unknown> = {
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    status: tournamentsTable.status,
    startDate: tournamentsTable.startDate,
  };
  for (const spec of ORG_NOTIFICATION_DEFAULT_SPECS) {
    projection[spec.key] = spec.tournamentColumn;
  }

  const rows = await db
    .select(projection as Record<string, never>)
    .from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.organizationId, orgId),
      inArray(tournamentsTable.status, RELEVANT_TOURNAMENT_STATUSES),
    ))
    .orderBy(desc(tournamentsTable.createdAt));
  res.json({ tournaments: rows });
});

// POST /organizations/:orgId/notification-defaults/apply-to-tournaments
//
// Bulk-applies one or more registered defaults to every still-relevant
// tournament in the org. Body shape (Task #1673):
//   { notifyManualEntryAlerts?: boolean, /* future keys ... */ }
// — pass `true`/`false` for each key you want to apply. Any registered
// key that's omitted falls back to the stored org-wide value (so the
// "Apply to all" button in the card can fire without re-reading state).
//
// Returns:
//   {
//     results: [{ key, value, updatedCount }, ...],
//     // Legacy fields preserved for callers that only deal with the
//     // manual-entry toggle (kept until the web client has fully
//     // migrated to the per-key results array).
//     notifyManualEntryAlerts?: boolean,
//     updatedCount?: number,
//   }
//
// Mirrors the list endpoint's status filter so completed/cancelled rows
// are left untouched even when their per-tournament value diverges.
// Task #2088 — Best-effort heads-up to a tournament's directors when an
// org admin's bulk-apply overwrites the per-event toggle recorded in
// `tournament_notification_override_audit`. Counterpart to the in-app
// override-notice banner (Task #1674).
//
// Recipients are the tournament's org's `org_admin /
// tournament_director / committee_member / competition_secretary` —
// the same definition every other director-fanout site uses
// (`manualEntryNotify`, `roundRobinTieBreakNotify`, the cron overdue
// escalation), because the schema has no tournament-scoped membership
// table. The actor who pressed bulk-apply is excluded.
// `dispatchNotification` honours each recipient's per-key email
// preference. All lookup / dispatch failures are swallowed so a
// downstream email problem never rolls back the committed bulk-apply.
async function notifyDirectorsOfOverrideApplied(opts: {
  orgId: number;
  appliedByUserId: number;
  changes: Array<{
    tournamentId: number;
    setting: string;
    previousValue: boolean;
    appliedValue: boolean;
  }>;
}): Promise<void> {
  if (opts.changes.length === 0) return;

  const baseUrl =
    (process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, ""))
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://kharagolf.com");

  // Mirrors `lib/manualEntryNotify.ts` DIRECTOR_ROLES so anyone trusted
  // with the underlying manual-entry alert also sees the override notice.
  const DIRECTOR_ROLES = ["org_admin", "tournament_director", "committee_member", "competition_secretary"] as const;

  // Load org branding once — used in every per-tournament email so the
  // existing notification email wrapper can show the club logo / colour.
  let branding: { orgName: string; logoUrl?: string; primaryColor?: string; orgId: number } = {
    orgName: "KHARAGOLF",
    orgId: opts.orgId,
  };
  try {
    const [org] = await db
      .select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, opts.orgId));
    if (org) {
      branding = {
        orgName: org.name ?? "KHARAGOLF",
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
        orgId: opts.orgId,
      };
    }
  } catch (err) {
    logger.warn({ orgId: opts.orgId, err }, "[override-applied-notify] org branding lookup failed");
  }

  // Resolve director recipients for the org once, excluding the actor.
  // See the recipient-scope comment block above for why org-level
  // membership is the right grain in this codebase.
  let recipientIds: number[] = [];
  try {
    const directors = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, opts.orgId),
        inArray(orgMembershipsTable.role, [...DIRECTOR_ROLES]),
      ));
    const seen = new Set<number>();
    for (const d of directors) {
      if (d.userId == null) continue;
      if (d.userId === opts.appliedByUserId) continue;
      if (seen.has(d.userId)) continue;
      seen.add(d.userId);
      recipientIds.push(d.userId);
    }
  } catch (err) {
    logger.warn({ orgId: opts.orgId, err }, "[override-applied-notify] director lookup failed");
    return;
  }
  if (recipientIds.length === 0) return;

  // Look up each affected tournament's name once so the per-tournament
  // email subject can name the event the override touched.
  const tournamentIds = Array.from(new Set(opts.changes.map(c => c.tournamentId)));
  const nameByTournament = new Map<number, string>();
  try {
    const rows = await db
      .select({ id: tournamentsTable.id, name: tournamentsTable.name })
      .from(tournamentsTable)
      .where(inArray(tournamentsTable.id, tournamentIds));
    for (const r of rows) nameByTournament.set(r.id, r.name ?? `Tournament #${r.id}`);
  } catch (err) {
    logger.warn({ orgId: opts.orgId, err }, "[override-applied-notify] tournament name lookup failed");
  }

  // Group changes by tournament so a single email per (tournament,
  // recipient) goes out even if the bulk-apply touched multiple keys
  // on the same event.
  const changesByTournament = new Map<number, typeof opts.changes>();
  for (const c of opts.changes) {
    const list = changesByTournament.get(c.tournamentId) ?? [];
    list.push(c);
    changesByTournament.set(c.tournamentId, list);
  }

  // CTA deep-links to the tournament settings anchor where the
  // existing `AutomationRulesPanel` banner exposes the authenticated
  // POST `/organizations/:orgId/tournaments/:tournamentId/manual-entry-override-notice/restore`
  // button (Task #1674). `dispatchNotification` honours each
  // recipient's per-key email preference.
  for (const [tournamentId, changes] of changesByTournament) {
    const tournamentName = nameByTournament.get(tournamentId) ?? `Tournament #${tournamentId}`;
    const safeName = escapeHtmlForOverrideAlert(tournamentName);
    const settingsList = changes
      .map(c => `<li>${escapeHtmlForOverrideAlert(c.setting)} → <strong>${c.appliedValue ? "on" : "off"}</strong> (was ${c.previousValue ? "on" : "off"})</li>`)
      .join("");
    const title = `A club admin changed notification settings on "${tournamentName}"`;
    const body =
      `An organisation admin bulk-applied the club-wide notification defaults and overwrote one or more settings on ${tournamentName}. ` +
      `Open the tournament settings page to review the change and restore your previous preference.`;
    const restoreUrl = `${baseUrl}/tournaments/${tournamentId}#manual-entry-override-notice`;
    const safeRestoreUrl = escapeHtmlForOverrideAlert(restoreUrl);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#fbbf24;">${escapeHtmlForOverrideAlert(title)}</h2>
        <p style="margin:0 0 12px;color:#d1d5db;line-height:1.5;">${escapeHtmlForOverrideAlert(body)}</p>
        <ul style="margin:0 0 16px 18px;color:#d1d5db;line-height:1.5;padding:0;">${settingsList}</ul>
        <p style="margin:16px 0 0;color:#d1d5db;line-height:1.5;">
          <a href="${safeRestoreUrl}" style="display:inline-block;padding:10px 16px;background:#22c55e;color:#0a0a0a;text-decoration:none;border-radius:8px;font-weight:600;">Restore my preference on ${safeName}</a>
        </p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Tournament id: ${tournamentId} · Org id: ${opts.orgId}</p>
      </div>`;

    try {
      await dispatchNotification("tournament.override.applied", recipientIds, {
        title,
        body,
        emailSubject: title,
        emailHtml,
        data: {
          organizationId: opts.orgId,
          tournamentId,
          tournamentName,
          changes: changes.map(c => ({
            setting: c.setting,
            previousValue: c.previousValue,
            appliedValue: c.appliedValue,
          })),
          restoreUrl,
        },
        branding,
      });
    } catch (err) {
      logger.warn(
        { orgId: opts.orgId, tournamentId, err },
        "[override-applied-notify] dispatch failed",
      );
    }
  }
}

function escapeHtmlForOverrideAlert(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

router.post("/:orgId/notification-defaults/apply-to-tournaments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  // First validate every supplied key — bail with 400 on any unknown or
  // non-boolean before touching the DB so a partial body doesn't leave
  // tournaments in a half-applied state.
  type Resolution = {
    key: OrgNotificationDefaultKey;
    target: boolean;
    column: typeof ORG_NOTIFICATION_DEFAULT_SPECS[number]["tournamentColumn"];
  };
  const explicit: Array<{ key: OrgNotificationDefaultKey; value: boolean }> = [];

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (!isOrgNotificationDefaultKey(key)) {
      res.status(400).json({ error: `Unknown notification default: ${key}` });
      return;
    }
    if (typeof value !== "boolean") {
      res.status(400).json({ error: `${key} must be a boolean` });
      return;
    }
    explicit.push({ key, value });
  }

  // Decide which keys to actually apply. Body keys win; any registered
  // key not mentioned in the body falls back to the stored org-wide
  // value — but ONLY if the body was empty (back-compat with the
  // single-toggle "Apply to all" affordance shipped in #1379, which
  // sends `{}` to mean "apply current org default to every tournament"
  // for the manual-entry toggle). When the caller is explicit about at
  // least one key, we don't auto-pull in the others.
  let resolutions: Resolution[];
  if (explicit.length > 0) {
    resolutions = explicit.map(({ key, value }) => {
      const spec = ORG_NOTIFICATION_DEFAULT_SPECS.find(s => s.key === key)!;
      return { key, target: value, column: spec.tournamentColumn };
    });
  } else {
    const orgProjection: Record<string, unknown> = {};
    for (const spec of ORG_NOTIFICATION_DEFAULT_SPECS) {
      orgProjection[spec.key] = spec.orgColumn;
    }
    const [orgRow] = await db
      .select(orgProjection as Record<string, never>)
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!orgRow) { { res.status(404).json({ error: "Organization not found" }); return; } }
    resolutions = ORG_NOTIFICATION_DEFAULT_SPECS.map(spec => ({
      key: spec.key,
      target: (orgRow as Record<string, boolean>)[spec.key],
      column: spec.tournamentColumn,
    }));
  }

  // Task #1674 — wrap each per-key UPDATE + audit insert in a single
  // transaction so an audit row is written for *every* tournament whose
  // stored value actually changed, and conversely so we never claim to
  // have audited a row whose update silently rolled back. The audit log
  // is what the tournament-detail page reads to surface the "your
  // preference was overridden by a club admin" notice with a one-click
  // restore. With the registry generalization (Task #1673) we now
  // write one audit row per (changed tournament, key) pair, using each
  // spec's snake_case db column name as the `setting` identifier so
  // future bulk-apply toggles reuse the same trail without a new
  // migration.
  //
  // The `<> target` predicate skips no-op rows so per-key
  // `updatedCount` reflects real changes (and we don't bump
  // `updated_at` unnecessarily). Per-key updates are sequential inside
  // the txn to keep the connection pool predictable; bulk applies
  // typically touch < a dozen tournaments per org so this is not a hot
  // path.
  const appliedByUserId = req.user!.id;
  // Task #2088 — collect every (tournamentId, setting, previousValue,
  // appliedValue) tuple that the transaction actually wrote so we can
  // fan-out a director-facing email AFTER the transaction commits. We
  // never dispatch from inside the txn so an email-side failure can't
  // roll back the audit / settings changes the user just confirmed.
  const overrideChanges: Array<{
    tournamentId: number;
    setting: string;
    previousValue: boolean;
    appliedValue: boolean;
  }> = [];
  const results: Array<{ key: OrgNotificationDefaultKey; value: boolean; updatedCount: number }> = await db.transaction(async (tx) => {
    const out: Array<{ key: OrgNotificationDefaultKey; value: boolean; updatedCount: number }> = [];
    for (const { key, target, column } of resolutions) {
      const changedRows = await tx
        .update(tournamentsTable)
        .set({ [key]: target, updatedAt: new Date() } as Partial<typeof tournamentsTable.$inferInsert>)
        .where(and(
          eq(tournamentsTable.organizationId, orgId),
          inArray(tournamentsTable.status, RELEVANT_TOURNAMENT_STATUSES),
          sql`${column} <> ${target}`,
        ))
        .returning({ id: tournamentsTable.id });

      if (changedRows.length > 0) {
        // `previousValue` is the negation of the new target — the
        // `<> target` predicate above already filtered to rows whose
        // stored value differs, and the column is a non-null boolean,
        // so the prior value is unambiguously `!target`. Storing it
        // explicitly keeps the audit row self-describing without a
        // second SELECT round-trip.
        await tx.insert(tournamentNotificationOverrideAuditTable).values(
          changedRows.map(r => ({
            tournamentId: r.id,
            organizationId: orgId,
            setting: column.name,
            previousValue: !target,
            appliedValue: target,
            appliedByUserId,
          })),
        );
        for (const r of changedRows) {
          overrideChanges.push({
            tournamentId: r.id,
            setting: column.name,
            previousValue: !target,
            appliedValue: target,
          });
        }
      }
      out.push({ key, value: target, updatedCount: changedRows.length });
    }
    return out;
  });

  // Task #2088 — fire the director-facing override-applied notification
  // AFTER the transaction commits. Best-effort: a dispatch failure must
  // not affect the response shape the web client relies on, so we await
  // the helper (which itself swallows every error to a logger.warn) but
  // never propagate failure to the caller.
  if (overrideChanges.length > 0) {
    try {
      await notifyDirectorsOfOverrideApplied({
        orgId,
        appliedByUserId,
        changes: overrideChanges,
      });
    } catch (err) {
      logger.warn(
        { orgId, appliedByUserId, err },
        "[override-applied-notify] post-commit dispatch wrapper threw",
      );
    }
  }

  // Preserve legacy top-level fields when the manual-entry key was
  // included so existing callers (and the inline "Apply to all" toast
  // copy in club-settings.tsx) keep working unchanged.
  const response: Record<string, unknown> = { results };
  const manual = results.find(r => r.key === "notifyManualEntryAlerts");
  if (manual) {
    response.notifyManualEntryAlerts = manual.value;
    response.updatedCount = manual.updatedCount;
  }
  res.json(response);
});

// PATCH /organizations/:orgId/language — update club default language
router.patch("/:orgId/language", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { defaultLanguage } = req.body;
  const supported = ["en", "hi", "ar", "es", "fr", "de", "pt", "ja", "ko", "zh", "th", "ms", "id", "vi", "fil", "sw", "af", "am", "ha", "zu", "yo"];
  if (!defaultLanguage || !supported.includes(defaultLanguage)) {
    res.status(400).json({ error: "Invalid language. Supported: en, hi, ar, es, fr, de, pt, ja, ko, zh, th, ms, id, vi, fil, sw, af, am, ha, zu, yo" });
    return;
  }

  const [org] = await db
    .update(organizationsTable)
    .set({ defaultLanguage: defaultLanguage as "en", updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json({ defaultLanguage: org.defaultLanguage });
});

// GET /organizations/:orgId/bounced-digest-prefs — Task #274
// Returns the current scheduling preferences for the bounced-levy reminders
// email digest. Visible to any member-admin role (org_admin / treasurer /
// membership_secretary), since they all receive the digest.
router.get("/:orgId/bounced-digest-prefs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;
  const [org] = await db.select({
    frequency: organizationsTable.bouncedDigestFrequency,
    hourLocal: organizationsTable.bouncedDigestHourLocal,
    timezone: organizationsTable.bouncedDigestTimezone,
    lastSentOn: organizationsTable.bouncedDigestLastSentOn,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json(org);
});

const BOUNCED_DIGEST_FREQUENCIES = new Set(["daily", "weekday", "weekly"]);
function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// PATCH /organizations/:orgId/bounced-digest-prefs — Task #274
router.patch("/:orgId/bounced-digest-prefs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const body = req.body as { frequency?: unknown; hourLocal?: unknown; timezone?: unknown };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!BOUNCED_DIGEST_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'daily', 'weekday' or 'weekly'" }); return;
  }

  let hourLocal: number | null = null;
  if (body.hourLocal !== null && body.hourLocal !== undefined && body.hourLocal !== "") {
    const n = Number(body.hourLocal);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      res.status(400).json({ error: "hourLocal must be an integer between 0 and 23" }); return;
    }
    hourLocal = n;
  }

  let timezone: string | null = null;
  if (typeof body.timezone === "string" && body.timezone.trim()) {
    timezone = body.timezone.trim();
    if (!isValidIanaTimezone(timezone)) {
      res.status(400).json({ error: `unknown IANA timezone: ${timezone}` }); return;
    }
  }

  // Snapshot the previous schedule so we can tell whether anything actually
  // changed (and avoid spamming recipients on a no-op save).
  const [prev] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    bouncedDigestFrequency: organizationsTable.bouncedDigestFrequency,
    bouncedDigestHourLocal: organizationsTable.bouncedDigestHourLocal,
    bouncedDigestTimezone: organizationsTable.bouncedDigestTimezone,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!prev) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Changing the schedule resets the per-day dedup so an admin can preview
  // the new cadence on the very next cron tick instead of waiting a day.
  const [org] = await db.update(organizationsTable)
    .set({
      bouncedDigestFrequency: frequency,
      bouncedDigestHourLocal: hourLocal,
      bouncedDigestTimezone: timezone,
      bouncedDigestLastSentOn: null,
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId))
    .returning({
      frequency: organizationsTable.bouncedDigestFrequency,
      hourLocal: organizationsTable.bouncedDigestHourLocal,
      timezone: organizationsTable.bouncedDigestTimezone,
      lastSentOn: organizationsTable.bouncedDigestLastSentOn,
    });
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Task #319 — heads-up email to current digest recipients when the schedule
  // actually changed. Rate-limited per-org so saving twice in <60s doesn't
  // double-spam the inbox.
  const scheduleChanged = prev.bouncedDigestFrequency !== org.frequency
    || prev.bouncedDigestHourLocal !== org.hourLocal
    || prev.bouncedDigestTimezone !== org.timezone;
  if (scheduleChanged) {
    void notifyBouncedDigestRecipientsOfScheduleChange({
      orgId,
      orgName: prev.name,
      logoUrl: prev.logoUrl,
      primaryColor: prev.primaryColor,
      changedByUserId: req.user!.id,
      oldSchedule: {
        frequency: prev.bouncedDigestFrequency,
        hourLocal: prev.bouncedDigestHourLocal,
        timezone: prev.bouncedDigestTimezone,
      },
      newSchedule: {
        frequency: org.frequency,
        hourLocal: org.hourLocal,
        timezone: org.timezone,
      },
    }).catch(err => logger.warn({ err, orgId }, "[organizations] schedule-change notify failed"));
  }

  res.json(org);
});

// POST /organizations/:orgId/bounced-digest-prefs/preview — Task #320
// Sends a one-off preview of the bounced-levy digest to the requesting admin
// only (not all recipients). Does NOT update bounced_digest_last_sent_on, so
// the regularly scheduled cron tick still fires as planned.
router.post("/:orgId/bounced-digest-prefs/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const user = req.user as { id: number; email?: string | null; displayName?: string | null; username?: string | null };
  if (!user.email) {
    res.status(400).json({ error: "Your account has no email address on file." });
    return;
  }

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  let summary;
  try {
    summary = await getBouncedLeviesForOrg(orgId);
  } catch (err) {
    res.status(500).json({ error: "Failed to aggregate bounced levies for preview." });
    return;
  }
  if (summary.totalBounced === 0 || summary.levies.length === 0) {
    res.status(409).json({ error: "There are no unresolved bounced reminders to preview right now." });
    return;
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  try {
    await sendBouncedLevyDigestEmail({
      to: user.email,
      staffName: user.displayName ?? user.username ?? "Admin",
      baseUrl,
      totalBounced: summary.totalBounced,
      levies: summary.levies,
      branding: {
        orgName: org.name,
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
      },
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to send preview email. Please try again." });
    return;
  }

  res.json({ ok: true, sentTo: user.email, totalBounced: summary.totalBounced, leviesAffected: summary.levies.length });
});

// Per-org throttle so editing twice in a minute doesn't fire two batches of
// confirmation emails. Task #654 — persisted to the `organizations` row
// (`bounced_digest_schedule_notify_at`) and claimed via an atomic conditional
// UPDATE so the throttle survives an API server restart and concurrent saves.
const SCHEDULE_NOTIFY_THROTTLE_MS = 60_000;

// Task #813 — Per-(org, sendId) cooldown enforced by the on-demand
// resend endpoint below. DB-backed via `bounced_digest_schedule_sends.
// last_resend_at` so it survives an API server restart and is consistent
// across concurrent requests.
const RESEND_COOLDOWN_MS = 60_000;

export function _resetBouncedDigestNotifyThrottleForTests(): void {
  // Throttle is now DB-backed and per-org. Tests use freshly-created orgs
  // (whose throttle column starts NULL), so no in-process state needs
  // clearing. Kept exported for backwards compatibility with existing test
  // suites that call it before each scenario.
}

async function notifyBouncedDigestRecipientsOfScheduleChange(opts: {
  orgId: number;
  orgName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  changedByUserId: number;
  oldSchedule: { frequency: string; hourLocal: number | null; timezone: string | null };
  newSchedule: { frequency: string; hourLocal: number | null; timezone: string | null };
}): Promise<void> {
  // Atomically claim the throttle slot in the DB. Only one notify per
  // SCHEDULE_NOTIFY_THROTTLE_MS window will succeed in flipping the
  // timestamp forward; concurrent or post-restart re-saves see no rows
  // returned and bail out, preserving the "exactly one email + one audit
  // row per 60s" guarantee even across an API server restart.
  const claimed = await db.execute(sql`
    UPDATE organizations
       SET bounced_digest_schedule_notify_at = NOW()
     WHERE id = ${opts.orgId}
       AND (bounced_digest_schedule_notify_at IS NULL
            OR bounced_digest_schedule_notify_at
               < NOW() - (${SCHEDULE_NOTIFY_THROTTLE_MS / 1000}::int * interval '1 second'))
     RETURNING id
  `);
  // drizzle's pg-driver `execute` returns a result with `.rows` (array).
  const claimedRows = (claimed as unknown as { rows?: unknown[] }).rows ?? (claimed as unknown as unknown[]);
  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    logger.info({ orgId: opts.orgId }, "[organizations] schedule-change notify skipped (throttled)");
    return;
  }

  // Resolve who changed it.
  const [actor] = await db.select({
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
    email: appUsersTable.email,
  }).from(appUsersTable).where(eq(appUsersTable.id, opts.changedByUserId));
  const changedByName = actor?.displayName ?? actor?.username ?? actor?.email ?? "An administrator";

  // Recipient set MUST mirror the cron's recipient discovery in
  // sendBouncedLevyRemindersDigest — same role gate (org_admin app_users +
  // org_memberships of org_admin/membership_secretary/treasurer).
  const directAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, opts.orgId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, opts.orgId),
      inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
    ));

  const seen = new Set<number>();
  const candidateRecipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return Boolean(a.email);
  });

  // Task #387 — recipients can opt out of *just* the schedule-change emails
  // (the regular bounced-levy digest still arrives). Filter them out here so
  // their inboxes stay clean.
  const optedOutRows = candidateRecipients.length === 0
    ? []
    : await db
        .select({ userId: bouncedDigestScheduleOptOutsTable.userId })
        .from(bouncedDigestScheduleOptOutsTable)
        .where(and(
          eq(bouncedDigestScheduleOptOutsTable.organizationId, opts.orgId),
          inArray(bouncedDigestScheduleOptOutsTable.userId, candidateRecipients.map(r => r.userId)),
        ));
  const optedOut = new Set(optedOutRows.map(r => r.userId));
  const recipients = candidateRecipients.filter(r => !optedOut.has(r.userId));

  if (recipients.length === 0) {
    logger.info({ orgId: opts.orgId, optedOut: optedOut.size }, "[organizations] schedule-change notify: no recipients");
    return;
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const branding = {
    orgName: opts.orgName,
    logoUrl: opts.logoUrl ?? undefined,
    primaryColor: opts.primaryColor ?? undefined,
  };

  let sent = 0;
  // Task #513 — capture who actually got the email (post-throttle, post-opt-out,
  // post-mailer-error) so the audit row reflects reality.
  const deliveredRecipients: Array<{ userId: number; email: string; displayName: string }> = [];
  for (const rec of recipients) {
    let unsubscribeUrl: string | undefined;
    try {
      const token = signBouncedDigestScheduleOptOutToken(rec.userId, opts.orgId);
      unsubscribeUrl = `${trimmedBase}/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`;
    } catch (err) {
      // SESSION_SECRET missing — log once and send the email without a link
      // rather than dropping the notification entirely.
      logger.warn({ err, orgId: opts.orgId }, "[organizations] could not sign schedule-change unsubscribe token");
    }
    const displayName = rec.displayName ?? rec.username ?? "Admin";
    try {
      await sendBouncedDigestScheduleChangedEmail({
        to: rec.email!,
        recipientName: displayName,
        changedByName,
        oldSchedule: opts.oldSchedule,
        newSchedule: opts.newSchedule,
        baseUrl,
        unsubscribeUrl,
        branding,
      });
      sent += 1;
      deliveredRecipients.push({ userId: rec.userId, email: rec.email!, displayName });
    } catch (err) {
      logger.warn({ err, orgId: opts.orgId, recipient: rec.email }, "[organizations] schedule-change email failed");
    }
  }
  logger.info({ orgId: opts.orgId, recipients: recipients.length, optedOut: optedOut.size, sent }, "[organizations] schedule-change notify sent");

  // Task #513 — record an audit row only if at least one recipient actually
  // received the email. The 60-second throttle above ensures rapid re-saves
  // do not double-count, and a "no recipients" run also writes nothing.
  if (deliveredRecipients.length > 0) {
    try {
      await db.insert(bouncedDigestScheduleSendsTable).values({
        organizationId: opts.orgId,
        changedByUserId: opts.changedByUserId,
        recipients: deliveredRecipients,
      });
    } catch (err) {
      logger.warn({ err, orgId: opts.orgId }, "[organizations] failed to record schedule-change send audit row");
    }
  }
}

// GET /organizations/:orgId/bounced-digest-schedule-sends — Task #513
// Returns the most recent schedule-change emails dispatched for this org so
// admins can see when the heads-up went out and exactly which recipients
// were notified. Same RBAC as the schedule editor itself.
router.get("/:orgId/bounced-digest-schedule-sends", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (Number.isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const rows = await db
    .select({
      id: bouncedDigestScheduleSendsTable.id,
      sentAt: bouncedDigestScheduleSendsTable.sentAt,
      recipients: bouncedDigestScheduleSendsTable.recipients,
      lastResendAt: bouncedDigestScheduleSendsTable.lastResendAt,
      changedByUserId: bouncedDigestScheduleSendsTable.changedByUserId,
      changedByDisplayName: appUsersTable.displayName,
      changedByUsername: appUsersTable.username,
      changedByEmail: appUsersTable.email,
    })
    .from(bouncedDigestScheduleSendsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, bouncedDigestScheduleSendsTable.changedByUserId))
    .where(eq(bouncedDigestScheduleSendsTable.organizationId, orgId))
    .orderBy(desc(bouncedDigestScheduleSendsTable.sentAt))
    .limit(10);

  res.json(rows.map(r => ({
    id: r.id,
    sentAt: r.sentAt,
    recipients: r.recipients ?? [],
    // Task #947 — surface the most recent resend timestamp so the UI can
    // re-derive the remaining cooldown after a page refresh without
    // round-tripping a 429.
    lastResendAt: r.lastResendAt ?? null,
    resendCooldownSeconds: RESEND_COOLDOWN_MS / 1000,
    changedBy: r.changedByUserId == null
      ? null
      : {
          userId: r.changedByUserId,
          displayName: r.changedByDisplayName ?? r.changedByUsername ?? r.changedByEmail ?? "Admin",
          email: r.changedByEmail,
        },
  })));
});

// POST /organizations/:orgId/bounced-digest-schedule-sends/:sendId/resend — Task #655
// Re-dispatch the schedule-change heads-up email to the same recipient list
// captured by the original audit row, without faking a schedule edit (which
// would reset bouncedDigestLastSentOn and re-run the throttle/opt-out logic).
// Writes a brand new audit row attributed to the admin who clicked Resend.
// Same RBAC as the schedule editor.
router.post("/:orgId/bounced-digest-schedule-sends/:sendId/resend", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const sendId = parseInt(String((req.params as Record<string, string>).sendId));
  if (Number.isNaN(orgId) || Number.isNaN(sendId)) {
    res.status(400).json({ error: "Invalid orgId or sendId" });
    return;
  }
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const [original] = await db
    .select({
      id: bouncedDigestScheduleSendsTable.id,
      recipients: bouncedDigestScheduleSendsTable.recipients,
    })
    .from(bouncedDigestScheduleSendsTable)
    .where(and(
      eq(bouncedDigestScheduleSendsTable.id, sendId),
      eq(bouncedDigestScheduleSendsTable.organizationId, orgId),
    ));
  if (!original) {
    res.status(404).json({ error: "Schedule-change send not found." });
    return;
  }

  const originalRecipients = (original.recipients ?? []) as Array<{
    userId: number; email: string; displayName: string;
  }>;
  if (originalRecipients.length === 0) {
    res.status(409).json({ error: "Original send had no recipients to resend to." });
    return;
  }

  // Task #813 — Per-(org, sendId) cooldown so rapid Resend clicks don't
  // spam the same recipients. Atomically claim the cooldown slot via a
  // conditional UPDATE on `last_resend_at`; concurrent clicks (and clicks
  // after an API restart) that land inside the window see no rows
  // returned and get a 429.
  const claimed = await db.execute(sql`
    UPDATE bounced_digest_schedule_sends
       SET last_resend_at = NOW()
     WHERE id = ${sendId}
       AND organization_id = ${orgId}
       AND (last_resend_at IS NULL
            OR last_resend_at
               < NOW() - (${RESEND_COOLDOWN_MS / 1000}::int * interval '1 second'))
     RETURNING id, last_resend_at AS "lastResendAt"
  `);
  const claimedRows = (claimed as unknown as { rows?: unknown[] }).rows
    ?? (claimed as unknown as unknown[]);
  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    // Task #947 — tell the admin exactly how many seconds remain on the
    // cooldown so the UI can show a precise countdown and disable the
    // Resend button until the window expires. Also set the standard
    // `Retry-After` header so generic HTTP clients honour the cooldown.
    const [current] = await db
      .select({ lastResendAt: bouncedDigestScheduleSendsTable.lastResendAt })
      .from(bouncedDigestScheduleSendsTable)
      .where(and(
        eq(bouncedDigestScheduleSendsTable.id, sendId),
        eq(bouncedDigestScheduleSendsTable.organizationId, orgId),
      ));
    const cooldownSeconds = RESEND_COOLDOWN_MS / 1000;
    const lastResendAtIso = current?.lastResendAt ? new Date(current.lastResendAt).toISOString() : null;
    let retryAfterSeconds = cooldownSeconds;
    if (current?.lastResendAt) {
      const elapsedMs = Date.now() - new Date(current.lastResendAt).getTime();
      const remainingMs = RESEND_COOLDOWN_MS - elapsedMs;
      retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    }
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: `This email was just resent. Please wait ${retryAfterSeconds}s before resending again.`,
      retryAfterSeconds,
      cooldownSeconds,
      lastResendAt: lastResendAtIso,
    });
    return;
  }
  const claimedRow = claimedRows[0] as { lastResendAt?: Date | string | null };
  const claimedAt = claimedRow?.lastResendAt
    ? new Date(claimedRow.lastResendAt).toISOString()
    : new Date().toISOString();

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    frequency: organizationsTable.bouncedDigestFrequency,
    hourLocal: organizationsTable.bouncedDigestHourLocal,
    timezone: organizationsTable.bouncedDigestTimezone,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const actor = req.user as { id: number; displayName?: string | null; username?: string | null; email?: string | null };
  const changedByName = actor.displayName ?? actor.username ?? actor.email ?? "An administrator";

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const branding = {
    orgName: org.name,
    logoUrl: org.logoUrl ?? undefined,
    primaryColor: org.primaryColor ?? undefined,
  };
  const currentSchedule = {
    frequency: org.frequency,
    hourLocal: org.hourLocal,
    timezone: org.timezone,
  };

  const delivered: Array<{ userId: number; email: string; displayName: string }> = [];
  for (const rec of originalRecipients) {
    if (!rec.email) continue;
    let unsubscribeUrl: string | undefined;
    try {
      const token = signBouncedDigestScheduleOptOutToken(rec.userId, orgId);
      unsubscribeUrl = `${trimmedBase}/api/public/bounced-digest-schedule-unsubscribe?token=${encodeURIComponent(token)}`;
    } catch (err) {
      logger.warn({ err, orgId }, "[organizations] resend: could not sign unsubscribe token");
    }
    try {
      await sendBouncedDigestScheduleChangedEmail({
        to: rec.email,
        recipientName: rec.displayName ?? "Admin",
        changedByName,
        oldSchedule: currentSchedule,
        newSchedule: currentSchedule,
        baseUrl,
        unsubscribeUrl,
        branding,
      });
      delivered.push({ userId: rec.userId, email: rec.email, displayName: rec.displayName ?? "Admin" });
    } catch (err) {
      logger.warn({ err, orgId, recipient: rec.email }, "[organizations] resend: schedule-change email failed");
    }
  }

  if (delivered.length === 0) {
    res.status(502).json({ error: "Failed to resend the email. Please try again." });
    return;
  }

  const [audit] = await db.insert(bouncedDigestScheduleSendsTable).values({
    organizationId: orgId,
    changedByUserId: actor.id,
    recipients: delivered,
  }).returning({
    id: bouncedDigestScheduleSendsTable.id,
    sentAt: bouncedDigestScheduleSendsTable.sentAt,
    recipients: bouncedDigestScheduleSendsTable.recipients,
  });

  res.status(201).json({
    id: audit.id,
    sentAt: audit.sentAt,
    recipients: audit.recipients ?? [],
    // Task #947 — echo cooldown details for both the new audit row (which
    // has not yet been resent, so its own cooldown is fresh) and the
    // original row whose `last_resend_at` we just claimed, so the client
    // can disable the right Resend button for the right amount of time.
    lastResendAt: null,
    resendCooldownSeconds: RESEND_COOLDOWN_MS / 1000,
    resentFromSendId: sendId,
    resentFromLastResendAt: claimedAt,
    changedBy: {
      userId: actor.id,
      displayName: actor.displayName ?? actor.username ?? actor.email ?? "Admin",
      email: actor.email ?? null,
    },
  });
});

// GET /organizations/:orgId/bounced-digest-schedule-opt-outs — Task #387
// Lists recipients who have unsubscribed from the schedule-change heads-up
// emails for this org so org admins can see who is silenced (without
// affecting the regular bounced-levy digest itself). Same RBAC as the
// digest schedule editor.
router.get("/:orgId/bounced-digest-schedule-opt-outs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (Number.isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const rows = await db
    .select({
      userId: bouncedDigestScheduleOptOutsTable.userId,
      optedOutAt: bouncedDigestScheduleOptOutsTable.optedOutAt,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(bouncedDigestScheduleOptOutsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, bouncedDigestScheduleOptOutsTable.userId))
    .where(eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId))
    .orderBy(desc(bouncedDigestScheduleOptOutsTable.optedOutAt));

  res.json(rows.map(r => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName ?? r.username ?? "Member",
    optedOutAt: r.optedOutAt,
  })));
});

// DELETE /organizations/:orgId/bounced-digest-schedule-opt-outs/:userId — Task #512
// Lets an org admin re-subscribe a member who previously opted out of the
// schedule-change heads-up emails (without needing direct DB access).
// Idempotent: a 204 is returned even if the user wasn't opted out.
router.delete("/:orgId/bounced-digest-schedule-opt-outs/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (Number.isNaN(orgId) || Number.isNaN(userId)) { { res.status(400).json({ error: "Invalid orgId or userId" }); return; } }
  if (!await requireMemberAdminForBouncedDigest(req, res, orgId)) return;

  const deleted = await db.delete(bouncedDigestScheduleOptOutsTable).where(and(
    eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
    eq(bouncedDigestScheduleOptOutsTable.userId, userId),
  )).returning({ userId: bouncedDigestScheduleOptOutsTable.userId });

  // Task #1401 — tell the affected member, via the in-app inbox, that an
  // admin just turned the schedule-change emails back on for them, with a
  // one-click link to opt back out. Only fire when we actually cleared a
  // row, so the idempotent re-call (no row to delete) stays silent. The
  // helper swallows its own errors and returns a result, so awaiting it
  // here cannot fail the DELETE — but it does guarantee the inbox row is
  // visible by the time the 204 is sent (no test flake, no "I just
  // re-subscribed but the recipient hasn't been told yet" race).
  if (deleted.length > 0) {
    const actor = req.user as { id: number; displayName?: string | null; username?: string | null; email?: string | null };
    await notifyBouncedDigestScheduleAdminResubscribed({
      orgId,
      affectedUserId: userId,
      actor,
    });
  }
  res.status(204).end();
});

// GET /organizations/:orgId/tie-break-email-opt-outs — Task #1208
// Mirrors the bounced-digest schedule-change opt-out admin endpoint above.
// Lists directors / members in the org who have opted out of the round-robin
// tie-break required alert email (Task #898 / opt-out table from Task #1045)
// so an org_admin or tournament_director can see who has silenced that
// email when chasing a "I never got the tie-break alert" report. The
// in-app inbox + push fan-outs are unaffected by this opt-out, so this
// list is the only way to attribute a missing email to a deliberate
// unsubscribe vs. a delivery failure.
router.get("/:orgId/tie-break-email-opt-outs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (Number.isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db
    .select({
      userId: roundRobinTieBreakEmailOptOutsTable.userId,
      optedOutAt: roundRobinTieBreakEmailOptOutsTable.optedOutAt,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(roundRobinTieBreakEmailOptOutsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, roundRobinTieBreakEmailOptOutsTable.userId))
    .where(eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId))
    .orderBy(desc(roundRobinTieBreakEmailOptOutsTable.optedOutAt));

  res.json(rows.map(r => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName ?? r.username ?? "Member",
    optedOutAt: r.optedOutAt,
  })));
});

// DELETE /organizations/:orgId/tie-break-email-opt-outs/:userId — Task #1208
// Lets an org_admin / tournament_director re-subscribe a director on their
// behalf (e.g. after they ask "please turn the tie-break emails back on for
// me"). Idempotent: 204 even when no opt-out row exists.
router.delete("/:orgId/tie-break-email-opt-outs/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = parseInt(String((req.params as Record<string, string>).userId));
  if (Number.isNaN(orgId) || Number.isNaN(userId)) { { res.status(400).json({ error: "Invalid orgId or userId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const deleted = await db.delete(roundRobinTieBreakEmailOptOutsTable).where(and(
    eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
    eq(roundRobinTieBreakEmailOptOutsTable.userId, userId),
  )).returning({ userId: roundRobinTieBreakEmailOptOutsTable.userId });

  // Task #1401 — tell the affected director, via the in-app inbox, that an
  // admin just turned the tie-break alert email back on for them, with a
  // one-click link to opt back out. Only fire when we actually cleared a
  // row, so the idempotent re-call (no row to delete) stays silent. The
  // helper swallows its own errors and returns a result, so awaiting it
  // here cannot fail the DELETE — but it does guarantee the inbox row is
  // visible by the time the 204 is sent.
  if (deleted.length > 0) {
    const actor = req.user as { id: number; displayName?: string | null; username?: string | null; email?: string | null };
    await notifyTieBreakAdminResubscribed({
      orgId,
      affectedUserId: userId,
      actor,
    });
  }
  res.status(204).end();
});

// Internal helper — same role gate as Member 360 admin surfaces (the digest's
// recipient set), inlined here so we don't pull in member-360 just for RBAC.
async function requireMemberAdminForBouncedDigest(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required." }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  if (user.role === "super_admin") return true;
  if (user.role === "org_admin" && user.organizationId === orgId) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (m && ["org_admin", "membership_secretary", "treasurer"].includes(m.role)) return true;
  res.status(403).json({ error: "You do not have admin access to this organization." });
  return false;
}

// Task #668 — Email org admins when a custom-domain HTTPS provisioning
// transitions to 'active' (so they can announce the new URL) or 'failed'
// (so they can fix DNS). De-duplication is enforced by an atomic conditional
// UPDATE on custom_domain_cert_notified_(status|host) so retries that land
// in the same state — including across an API server restart — don't
// re-spam admins. Async / best-effort: any failure is logged but never
// propagates to the request that triggered it.
export async function notifyCustomDomainCertTransition(opts: {
  orgId: number;
  host: string;
  status: CertStatus;
  errorMessage: string | null;
}): Promise<void> {
  const { orgId, host, status } = opts;
  if (status !== "active" && status !== "failed") return;
  if (!host) return;

  try {
    // Atomic dedup claim. Only proceed if this (host, status) tuple is
    // different from what we last emailed about for this org.
    // Task #818 — Also stamp custom_domain_cert_notified_at so admins can
    // see when the email actually went out. Stamped inside the same
    // conditional UPDATE so it only advances when we successfully claim
    // the dedup slot (i.e. when we're really about to send).
    const notifiedAt = new Date();
    const claimed = await db.execute(sql`
      UPDATE organizations
         SET custom_domain_cert_notified_status = ${status},
             custom_domain_cert_notified_host = ${host},
             custom_domain_cert_notified_at = ${notifiedAt}
       WHERE id = ${orgId}
         AND (custom_domain_cert_notified_status IS DISTINCT FROM ${status}
              OR custom_domain_cert_notified_host IS DISTINCT FROM ${host})
       RETURNING id
    `);
    const claimedRows = (claimed as unknown as { rows?: unknown[] }).rows ?? (claimed as unknown as unknown[]);
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
      logger.info({ orgId, host, status }, "[organizations] custom-domain cert notify skipped (already sent)");
      return;
    }

    await sendCustomDomainCertEmailsForOrg({
      orgId, host, status, errorMessage: opts.errorMessage,
      // Task #1255 — for failed transitions, the next re-nudge will land
      // CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS after this notification.
      // Computed from the same `notifiedAt` we just stamped above so the
      // email matches what the in-app panel (Task #1100) shows.
      nextReminderAt: status === "failed"
        ? new Date(notifiedAt.getTime() + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000)
        : null,
    });
  } catch (err) {
    logger.warn({ err, orgId, host, status }, "[organizations] custom-domain cert notify failed");
  }
}

// Shared recipient discovery + email send for custom-domain HTTPS admin
// notifications. Used by both the on-transition notify (above) and the
// scheduled re-nudge (below). Caller is responsible for any dedup / claim
// logic before invoking this.
async function sendCustomDomainCertEmailsForOrg(opts: {
  orgId: number;
  host: string;
  status: "active" | "failed";
  errorMessage: string | null;
  /**
   * Task #1255 — When the status is `failed`, callers pass the timestamp
   * at which the next re-nudge will land (computed from
   * CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS) so the email can render
   * "we'll email you again on <date>." Ignored for `active` emails.
   */
  nextReminderAt?: Date | null;
  /**
   * Task #1262 — When the re-nudge job fired this email because the
   * admin's snooze window just elapsed, the caller passes the previous
   * snoozed-until timestamp so the email can render a one-line header
   * acknowledging "you snoozed this until X — that snooze has now
   * ended." Ignored for `active` emails and for failed emails where
   * no snooze was active.
   */
  previouslySnoozedUntil?: Date | null;
}): Promise<{ recipients: number; sent: number }> {
  const { orgId, host, status } = opts;
  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    // Task #817 — render the admin email in the club's chosen language.
    defaultLanguage: organizationsTable.defaultLanguage,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) return { recipients: 0, sent: 0 };

  // Recipients: app_users with role 'org_admin' for this org, plus any
  // org_memberships with role 'org_admin' (mirrors the broader admin
  // discovery used elsewhere in this file).
  const directAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.role, "org_admin"),
    ));
  const seen = new Set<number>();
  const recipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return Boolean(a.email);
  });
  if (recipients.length === 0) {
    logger.info({ orgId, host, status }, "[organizations] custom-domain cert notify: no recipients");
    return { recipients: 0, sent: 0 };
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const branding = {
    orgName: org.name,
    logoUrl: org.logoUrl ?? undefined,
    primaryColor: org.primaryColor ?? undefined,
  };

  let sent = 0;
  for (const rec of recipients) {
    const recipientName = rec.displayName ?? rec.username ?? rec.email!.split("@")[0];
    try {
      if (status === "active") {
        await sendCustomDomainHttpsActiveEmail({
          to: rec.email!,
          recipientName,
          host,
          baseUrl,
          branding,
          // Task #817 — pass org default language so the email respects it.
          lang: org.defaultLanguage,
        });
      } else {
        await sendCustomDomainHttpsFailedEmail({
          to: rec.email!,
          recipientName,
          host,
          errorMessage: opts.errorMessage,
          baseUrl,
          branding,
          // Task #817 — pass org default language so the email respects it.
          lang: org.defaultLanguage,
          // Task #1255 — surface the next re-nudge ETA inside the email.
          nextReminderAt: opts.nextReminderAt ?? null,
          // Task #1262 — when the re-nudge fired because a snooze just
          // ended, render a header line acknowledging the snooze.
          previouslySnoozedUntil: opts.previouslySnoozedUntil ?? null,
        });
      }
      sent++;
    } catch (err) {
      logger.warn({ err, orgId, host, status, to: rec.email }, "[organizations] custom-domain cert email send failed");
    }
  }
  logger.info({ orgId, host, status, sent, recipients: recipients.length }, "[organizations] custom-domain cert notify complete");
  return { recipients: recipients.length, sent };
}

// Task #951 — Periodic re-nudge for custom-domain HTTPS that has been stuck
// in 'failed' for too long. The original `notifyCustomDomainCertTransition`
// only fires once per (host, status) transition (deduped by
// custom_domain_cert_notified_(status|host)) so an admin who never reads
// the inbox would never be nudged again. This scheduled job re-sends the
// failed email after the cert has been failed and notified at least
// `CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS` days ago, then advances
// custom_domain_cert_notified_at so the admin UI line stays accurate AND
// the next re-nudge is held off for another full window.
//
// Re-nudges stop automatically because:
//   - We only select rows where status='failed' AND notified_status='failed'
//     AND notified_host = customDomain. The PATCH /branding flow resets the
//     notified_* tuple when the domain is cleared/changed, and any
//     transition to 'active' replaces notified_status (handled by
//     notifyCustomDomainCertTransition itself).
export const CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS = 7;

export async function renudgeStaleCustomDomainHttpsFailures(opts: {
  thresholdDays?: number;
} = {}): Promise<{ candidates: number; renudged: number }> {
  const thresholdDays = opts.thresholdDays ?? CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS;
  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

  // Find orgs whose HTTPS is still failed for the same host we last emailed
  // about, and whose last notification is older than the cutoff.
  const candidates = await db
    .select({
      id: organizationsTable.id,
      customDomain: organizationsTable.customDomain,
      notifiedHost: organizationsTable.customDomainCertNotifiedHost,
      notifiedAt: organizationsTable.customDomainCertNotifiedAt,
      error: organizationsTable.customDomainCertError,
      // Task #1262 — track the snooze-until so we can tell whether this
      // re-nudge fired because a snooze just elapsed (vs because the
      // standard threshold passed). Used to render the "you snoozed this
      // until X — that snooze has now ended" header in the email body.
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    })
    .from(organizationsTable)
    .where(and(
      eq(organizationsTable.customDomainCertStatus, "failed"),
      eq(organizationsTable.customDomainCertNotifiedStatus, "failed"),
      isNotNull(organizationsTable.customDomain),
      isNotNull(organizationsTable.customDomainCertNotifiedHost),
      isNotNull(organizationsTable.customDomainCertNotifiedAt),
      lte(organizationsTable.customDomainCertNotifiedAt, cutoff),
      // Task #1101 — admins can snooze the re-nudge while they fix DNS;
      // skip orgs whose snooze window is still in the future.
      or(
        isNull(organizationsTable.customDomainCertRenudgeSnoozedUntil),
        lte(organizationsTable.customDomainCertRenudgeSnoozedUntil, now),
      ),
    ));

  let renudged = 0;
  for (const row of candidates) {
    const host = (row.customDomain ?? "").trim().toLowerCase();
    const notifiedHost = (row.notifiedHost ?? "").trim().toLowerCase();
    // Only re-nudge if the host hasn't changed since we last notified.
    if (!host || host !== notifiedHost) continue;

    // Atomic claim: bump notified_at to "now" only if no other concurrent
    // process has already done so (i.e. notified_at is still <= cutoff and
    // status/host still match). Survives an API server restart and avoids
    // duplicate nudges if multiple instances run the cron simultaneously.
    //
    // Task #1262 — Also clear the snooze-until column atomically. The
    // snooze invariant in the WHERE means the snooze was either NULL or
    // already in the past at claim time, so clearing it loses no
    // information and prevents the "you snoozed this" header from being
    // re-rendered on every subsequent re-nudge in the same failure cycle.
    //
    // Task #1482 — Capture the elapsed snooze date in
    // `custom_domain_cert_snooze_ended_from_until` in the same atomic
    // UPDATE so the in-app HTTPS panel can render the same "you snoozed
    // this until X — that snooze has now ended" acknowledgement that
    // the email body shows. PostgreSQL evaluates every SET expression
    // against the row's pre-UPDATE values, so copying from the column
    // we're nulling on the next line works correctly. Threshold-only
    // re-nudges (snoozedUntil was already NULL) copy NULL, which is
    // exactly what we want — no banner without a snooze.
    const claimed = await db.execute(sql`
      UPDATE organizations
         SET custom_domain_cert_notified_at = ${now},
             custom_domain_cert_snooze_ended_from_until = custom_domain_cert_renudge_snoozed_until,
             custom_domain_cert_renudge_snoozed_until = NULL
       WHERE id = ${row.id}
         AND custom_domain_cert_status = 'failed'
         AND custom_domain_cert_notified_status = 'failed'
         AND custom_domain_cert_notified_host = ${host}
         AND custom_domain_cert_notified_at IS NOT NULL
         AND custom_domain_cert_notified_at <= ${cutoff}
         -- Task #1101 — also re-assert the snooze invariant inside the
         -- atomic claim so an admin who set a snooze in between our
         -- candidate SELECT and this UPDATE doesn't get an extra nudge.
         AND (custom_domain_cert_renudge_snoozed_until IS NULL
              OR custom_domain_cert_renudge_snoozed_until <= ${now})
       RETURNING id
    `);
    const claimedRows = (claimed as unknown as { rows?: unknown[] }).rows ?? (claimed as unknown as unknown[]);
    if (!Array.isArray(claimedRows) || claimedRows.length === 0) continue;

    // Task #1262 — If the candidate SELECT saw a non-null snoozedUntil that
    // had already elapsed (it's required to be <= now by the WHERE clause
    // we already passed) then this re-nudge fired because the snooze just
    // ended, not just because the threshold passed. Tell the email so it
    // can render the "you snoozed this until X — that snooze has now
    // ended" header. A future snooze set between the SELECT and the UPDATE
    // would have caused the atomic claim to fail (the OR in the WHERE),
    // so the SELECT-time value is safe to reuse here.
    const previouslySnoozedUntil = row.snoozedUntil && row.snoozedUntil.getTime() <= now.getTime()
      ? row.snoozedUntil
      : null;

    try {
      await sendCustomDomainCertEmailsForOrg({
        orgId: row.id,
        host,
        status: "failed",
        errorMessage: row.error ?? null,
        // Task #1255 — surface the next re-nudge ETA inside the email.
        // We just advanced notified_at to `now`, so the next re-nudge will
        // land `thresholdDays` later. Stays in sync with the in-app panel.
        nextReminderAt: new Date(now.getTime() + thresholdDays * 24 * 60 * 60 * 1000),
        // Task #1262 — when set, the email renders a one-line header
        // acknowledging the elapsed snooze.
        previouslySnoozedUntil,
      });
      renudged++;
      logger.info(
        { orgId: row.id, host, prevNotifiedAt: row.notifiedAt, snoozeEnded: previouslySnoozedUntil !== null },
        "[organizations] custom-domain HTTPS failed re-nudge sent",
      );
    } catch (err) {
      logger.warn({ err, orgId: row.id, host }, "[organizations] custom-domain HTTPS failed re-nudge failed");
    }
  }

  if (candidates.length > 0) {
    logger.info({ candidates: candidates.length, renudged, thresholdDays }, "[organizations] custom-domain HTTPS failed re-nudge pass complete");
  }
  return { candidates: candidates.length, renudged };
}

// PATCH /organizations/:orgId/branding — update only branding fields (logo, colour, domain)
// Gated: customDomain requires Enterprise; all other branding is free (but customDomain in body triggers gate)
//
// Task #581 — When the customDomain field changes we also call the configured
// ingress provider so HTTPS is provisioned automatically. The cert lifecycle
// is recorded in the org row (custom_domain_cert_*) and surfaced to the admin
// UI via /custom-domain/status + /custom-domain/retry below.
router.patch("/:orgId/branding", gateBranding(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { logoUrl, primaryColor, customDomain } = req.body;

  // Look up the existing custom domain so we can detect a real change and
  // de-register the old hostname when an admin replaces or clears it.
  const [existing] = await db
    .select({ customDomain: organizationsTable.customDomain })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!existing) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Task #663 — share the canonical normaliser so values written here are
  // also trimmed/lowercased/port-stripped (matches POST/PUT and the
  // by-host lookup's expectations).
  const normalize = (v: unknown): string | null => {
    const out = normalizeCustomDomainForStorage(v);
    return out === undefined ? null : out;
  };
  const oldHost = normalize(existing.customDomain);
  const hasNewDomainField = customDomain !== undefined;
  const newHost = hasNewDomainField ? normalize(customDomain) : oldHost;
  const domainChanged = hasNewDomainField && newHost !== oldHost;

  const setPatch: Record<string, unknown> = { logoUrl, primaryColor, updatedAt: new Date() };
  if (hasNewDomainField) setPatch.customDomain = newHost;

  // Talk to the ingress provider before we commit, so we can store the
  // initial cert state in the same UPDATE. If the provider call throws we
  // still persist the new domain but record status='failed' with the reason.
  let ingressResult: { provider: string; status: CertStatus; error?: string } | null = null;
  if (domainChanged) {
    if (newHost) {
      try {
        ingressResult = await getIngressClient().registerHostname(newHost);
      } catch (e) {
        ingressResult = {
          provider: getIngressClient().provider,
          status: "failed",
          error: e instanceof Error ? e.message : "Ingress request failed",
        };
      }
      const now = new Date();
      setPatch.customDomainCertStatus = ingressResult.status;
      setPatch.customDomainCertProvider = ingressResult.provider;
      setPatch.customDomainCertError = ingressResult.error ?? null;
      setPatch.customDomainCertRequestedAt = now;
      setPatch.customDomainCertCheckedAt = now;
      setPatch.customDomainCertIssuedAt = ingressResult.status === "active" ? now : null;
    } else {
      // Cleared the domain — reset the cert tracking columns.
      setPatch.customDomainCertStatus = "none";
      setPatch.customDomainCertProvider = null;
      setPatch.customDomainCertError = null;
      setPatch.customDomainCertRequestedAt = null;
      setPatch.customDomainCertIssuedAt = null;
      setPatch.customDomainCertCheckedAt = null;
    }
    // Task #668 — reset the notify-dedup tuple on any domain change so the
    // next 'active' / 'failed' transition for the new (or re-added) host
    // re-arms the email.
    setPatch.customDomainCertNotifiedStatus = null;
    setPatch.customDomainCertNotifiedHost = null;
    // Task #818 — also clear the surfaced timestamp on any domain change.
    setPatch.customDomainCertNotifiedAt = null;
    // Task #1101 — clear any active re-nudge snooze when the domain
    // changes (or is cleared); a brand new host should start with a
    // clean slate, not inherit the previous host's silence window.
    setPatch.customDomainCertRenudgeSnoozedUntil = null;
    // Task #1482 — and drop the "your snooze just ended" banner: the
    // domain change is itself an admin action that clears the banner.
    setPatch.customDomainCertSnoozeEndedFromUntil = null;
  }

  const [org] = await db
    .update(organizationsTable)
    .set(setPatch)
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Best-effort: tear down the old hostname registration after the row
  // commits. Failure here is logged inside the client and never blocks save.
  if (domainChanged && oldHost && oldHost !== newHost) {
    void getIngressClient().removeHostname(oldHost);
  }

  // Task #668 — fire the "HTTPS live / failed" admin email when this save
  // landed in a notify-worthy terminal state. Async / best-effort.
  if (domainChanged && newHost && ingressResult
      && (ingressResult.status === "active" || ingressResult.status === "failed")) {
    void notifyCustomDomainCertTransition({
      orgId,
      host: newHost,
      status: ingressResult.status,
      errorMessage: ingressResult.error ?? null,
    });
  }

  res.json(org);
});

// Task #581 — Lightweight read endpoint the admin UI polls to show the
// current TLS provisioning state for the club's vanity domain.
router.get("/:orgId/custom-domain/status", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [org] = await db
    .select({
      customDomain: organizationsTable.customDomain,
      status: organizationsTable.customDomainCertStatus,
      provider: organizationsTable.customDomainCertProvider,
      error: organizationsTable.customDomainCertError,
      requestedAt: organizationsTable.customDomainCertRequestedAt,
      issuedAt: organizationsTable.customDomainCertIssuedAt,
      checkedAt: organizationsTable.customDomainCertCheckedAt,
      // Task #818 — surface the last admin-notification record so the UI
      // can render "Last notified admins: HTTPS active on Apr 21, 14:02".
      notifiedStatus: organizationsTable.customDomainCertNotifiedStatus,
      notifiedHost: organizationsTable.customDomainCertNotifiedHost,
      notifiedAt: organizationsTable.customDomainCertNotifiedAt,
      // Task #1101 — surface the active re-nudge snooze (if any) so the
      // admin UI can show "Re-nudge snoozed until Apr 30" alongside the
      // last-notified line.
      renudgeSnoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
      // Task #1482 — captured by the re-nudge job at the moment it
      // sent the snooze-ended email. Surfaced (gated by the 7-day
      // freshness window below) so the admin panel can render the
      // same "you snoozed this until X — that snooze has now ended"
      // banner the email body shows.
      snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  // Task #1100 — derive when the platform will email the admins again about
  // a still-failing HTTPS cert. Computed from notifiedAt + the re-nudge
  // threshold so it stays in sync if the threshold is tuned. Only
  // meaningful while we're actively re-nudging on this same host (status
  // and notified_status both 'failed', and the host still matches what we
  // last emailed about).
  let nextRenudgeAt: string | null = null;
  if (
    org.status === "failed" &&
    org.notifiedStatus === "failed" &&
    org.notifiedAt &&
    org.notifiedHost &&
    (org.customDomain ?? "").trim().toLowerCase() === org.notifiedHost.trim().toLowerCase()
  ) {
    const next = new Date(
      new Date(org.notifiedAt).getTime()
        + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000,
    );
    nextRenudgeAt = next.toISOString();
  }
  // Task #1482 — Hide the "your snooze just ended" acknowledgement once
  // the most recent admin notification (which is when the cron fired the
  // snooze-ended email) is older than CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS.
  // The banner is also explicitly cleared on the next admin action
  // (retry / snooze / cancel-snooze / domain change) and any 'active'
  // flip, so this TTL is just the safety net for the "admin never opened
  // the panel during the window" case.
  let snoozeEndedFromUntil: string | null = null;
  if (org.snoozeEndedFromUntil && org.notifiedAt) {
    const ageMs = Date.now() - new Date(org.notifiedAt).getTime();
    if (ageMs >= 0 && ageMs <= CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS * 24 * 60 * 60 * 1000) {
      snoozeEndedFromUntil = new Date(org.snoozeEndedFromUntil).toISOString();
    }
  }
  res.json({ ...org, nextRenudgeAt, snoozeEndedFromUntil });
});

// Task #1482 — How long the "your snooze just ended" acknowledgement
// stays visible in the in-app HTTPS panel after the resumed re-nudge
// email goes out. Matches the re-nudge cadence
// (CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS) so the banner naturally
// rolls over to the "next reminder" line when the following re-nudge
// fires, and a stale banner can never linger longer than one re-nudge
// cycle even if no admin action ever clears it.
export const CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS = 7;

// Task #581 — Re-poll the ingress provider for the current cert status, or
// re-issue the registration if it previously failed. Used by the "Retry"
// button in the admin UI.
router.post("/:orgId/custom-domain/retry", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [org] = await db
    .select({
      customDomain: organizationsTable.customDomain,
      status: organizationsTable.customDomainCertStatus,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  const host = (org.customDomain ?? "").trim().toLowerCase();
  if (!host) {
    res.status(400).json({ error: "No custom domain configured for this club." });
    return;
  }

  const client = getIngressClient();
  let result: { provider: string; status: CertStatus; error?: string };
  try {
    // If the previous attempt failed we re-register; otherwise we just
    // ask the provider for the latest status.
    result = org.status === "failed" || org.status === "none"
      ? await client.registerHostname(host)
      : await client.getHostnameStatus(host);
  } catch (e) {
    result = {
      provider: client.provider,
      status: "failed",
      error: e instanceof Error ? e.message : "Ingress request failed",
    };
  }
  const now = new Date();
  const [updated] = await db
    .update(organizationsTable)
    .set({
      customDomainCertStatus: result.status,
      customDomainCertProvider: result.provider,
      customDomainCertError: result.error ?? null,
      customDomainCertCheckedAt: now,
      ...(org.status === "failed" || org.status === "none"
        ? { customDomainCertRequestedAt: now }
        : {}),
      ...(result.status === "active" ? { customDomainCertIssuedAt: now } : {}),
      // Task #1101 — once the cert flips to 'active' the snooze is moot;
      // clear it so a future regression starts fresh and the admin UI no
      // longer shows a stale "snoozed until …" line.
      ...(result.status === "active" ? { customDomainCertRenudgeSnoozedUntil: null } : {}),
      // Task #1482 — Retry is itself an admin action: any retry (whether
      // it ends up active, still failed, or pending) acknowledges the
      // resumed nudge. Clear the "your snooze just ended" banner so the
      // panel doesn't keep nagging an admin who has already acted.
      customDomainCertSnoozeEndedFromUntil: null,
      updatedAt: now,
    })
    .where(eq(organizationsTable.id, orgId))
    .returning({
      customDomain: organizationsTable.customDomain,
      status: organizationsTable.customDomainCertStatus,
      provider: organizationsTable.customDomainCertProvider,
      error: organizationsTable.customDomainCertError,
      requestedAt: organizationsTable.customDomainCertRequestedAt,
      issuedAt: organizationsTable.customDomainCertIssuedAt,
      checkedAt: organizationsTable.customDomainCertCheckedAt,
    });

  // Task #668 — same notify path as PATCH /branding. The dedup column
  // ensures repeated retries that land in the same state don't re-spam.
  if (result.status === "active" || result.status === "failed") {
    void notifyCustomDomainCertTransition({
      orgId,
      host,
      status: result.status,
      errorMessage: result.error ?? null,
    });
  }

  res.json(updated);
});

// Task #1101 — POST /organizations/:orgId/custom-domain/snooze-renudge
// Lets an admin who knows their HTTPS provisioning is broken (e.g. mid-DNS
// migration) silence the periodic re-nudge email for a bounded window
// without having to clear/re-add the domain. Default 14 days, capped to 90.
// The snooze auto-clears when the cert flips to 'active' (PATCH /branding,
// retry, or the pending-recheck cron) or when the custom domain is cleared.
export const CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS = 14;
export const CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_MAX_DAYS = 90;

router.post("/:orgId/custom-domain/snooze-renudge", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rawDays = req.body?.days;
  let days = CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS;
  if (rawDays !== undefined && rawDays !== null) {
    const n = typeof rawDays === "number" ? rawDays : Number(rawDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_MAX_DAYS) {
      res.status(400).json({
        error: `days must be an integer between 1 and ${CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_MAX_DAYS}.`,
      });
      return;
    }
    days = n;
  }

  const [org] = await db
    .select({
      customDomain: organizationsTable.customDomain,
      status: organizationsTable.customDomainCertStatus,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  // Snoozing only makes sense while there's actually a failing custom
  // domain to silence. Reject otherwise so the UI doesn't accidentally
  // park a stale snooze that will outlive the next domain change.
  if (!org.customDomain || org.status !== "failed") {
    res.status(400).json({
      error: "Snooze is only available while the custom domain HTTPS provisioning is in 'failed' state.",
    });
    return;
  }

  const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  // Re-assert the status='failed' + same-host invariant inside the UPDATE
  // so a concurrent flip-to-active or domain change between the SELECT
  // above and this write can't park a stale snooze.
  const [updated] = await db
    .update(organizationsTable)
    .set({
      customDomainCertRenudgeSnoozedUntil: snoozedUntil,
      // Task #1482 — Setting a fresh snooze is itself an admin action
      // acknowledging the resumed nudges; drop the "your snooze just
      // ended" banner so the panel doesn't show contradictory state
      // (banner above + active snooze line below).
      customDomainCertSnoozeEndedFromUntil: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(organizationsTable.id, orgId),
      eq(organizationsTable.customDomainCertStatus, "failed"),
      eq(organizationsTable.customDomain, org.customDomain),
    ))
    .returning({
      renudgeSnoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    });
  if (!updated) {
    res.status(409).json({
      error: "Custom domain state changed since the snooze request started; please reload and try again.",
    });
    return;
  }

  logger.info({ orgId, host: org.customDomain, days, snoozedUntil }, "[organizations] custom-domain HTTPS re-nudge snoozed");
  res.json({ renudgeSnoozedUntil: updated.renudgeSnoozedUntil, days });
});

// Task #1261 — DELETE /organizations/:orgId/custom-domain/snooze-renudge
// Companion to the POST above: lets the admin UI's "Cancel snooze" button
// lift an active re-nudge snooze immediately so the periodic email
// resumes on its normal cadence. Returning the (now null) snooze in the
// same shape the GET /custom-domain/status endpoint uses keeps the
// client cache update trivial. Idempotent — clearing an already-clear
// snooze returns 200 with renudgeSnoozedUntil: null.
router.delete("/:orgId/custom-domain/snooze-renudge", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [org] = await db
    .select({
      customDomain: organizationsTable.customDomain,
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  // Task #1482 — Cancel-snooze is itself an admin action. Always run
  // the UPDATE (even when no snooze is active) so we also clear the
  // "your snooze just ended" banner, otherwise an admin who cancels a
  // re-snooze right after the previous snooze elapsed would still see
  // the banner from the elapsed-snooze re-nudge above the now-cancelled
  // snooze controls.
  await db
    .update(organizationsTable)
    .set({
      customDomainCertRenudgeSnoozedUntil: null,
      customDomainCertSnoozeEndedFromUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId));
  if (org.snoozedUntil !== null) {
    logger.info({ orgId, host: org.customDomain }, "[organizations] custom-domain HTTPS re-nudge snooze cancelled");
  }

  res.json({ renudgeSnoozedUntil: null });
});

// POST /organizations/:orgId/branding/logo-upload-url — get signed upload URL for logo
router.post("/:orgId/branding/logo-upload-url", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { contentType } = req.body;
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"];
  if (!allowed.includes(contentType)) {
    res.status(400).json({ error: "Invalid content type. Use PNG, JPEG, SVG or WebP." });
    return;
  }

  const ext = contentType.split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
  const objectPath = `logos/org-${orgId}.${ext}`;

  try {
    const { objectStorageClient } = await import("../lib/objectStorage");
    const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
    const bucketObj = objectStorageClient.bucket(bucket);
    const file = bucketObj.file(objectPath);
    const [uploadUrl] = await file.getSignedUrl({
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });

    const publicUrl = `https://storage.googleapis.com/${bucket}/${objectPath}`;
    res.json({ uploadUrl, objectPath, publicUrl });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// GET /organizations/:orgId/stats
router.get("/:orgId/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const [totalTournaments] = await db.select({ count: count() }).from(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
  const [activeTournaments] = await db.select({ count: count() }).from(tournamentsTable).where(sql`${tournamentsTable.organizationId} = ${orgId} AND ${tournamentsTable.status} = 'active'`);

  const playerResult = await db
    .select({ count: count() })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, playersTable.tournamentId))
    .where(eq(tournamentsTable.organizationId, orgId));
  const [totalPlayers] = playerResult;

  res.json({
    totalTournaments: Number(totalTournaments?.count ?? 0),
    activeTournaments: Number(activeTournaments?.count ?? 0),
    totalPlayers: Number(totalPlayers?.count ?? 0),
    totalRounds: 0,
    recentActivity: [],
  });
});

// GET /organizations/:orgId/unlinked-player-records
// Returns all player records in this org's tournaments that are NOT yet linked to a portal account.
// Requires org_admin or tournament_director role for this organization.
router.get("/:orgId/unlinked-player-records", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const records = await db
    .select({
      playerId: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      email: playersTable.email,
      tournamentId: playersTable.tournamentId,
      tournamentName: tournamentsTable.name,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      and(
        eq(tournamentsTable.organizationId, orgId),
        isNull(playersTable.userId)
      )
    )
    .orderBy(tournamentsTable.name, playersTable.lastName, playersTable.firstName);

  res.json(records);
});

// GET /organizations/:orgId/club-stats — comprehensive club analytics (scoring leaders, format popularity, etc.)
// Gated: requires Pro plan (advancedAnalytics)
router.get("/:orgId/club-stats", gateAdvancedAnalytics(), async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // All tournaments for this org
  const allTournaments = await db.select({
    id: tournamentsTable.id, name: tournamentsTable.name, format: tournamentsTable.format,
    status: tournamentsTable.status, startDate: tournamentsTable.startDate,
    courseId: tournamentsTable.courseId, entryFee: tournamentsTable.entryFee,
  }).from(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId)).orderBy(asc(tournamentsTable.startDate));

  const tournamentIds = allTournaments.map(t => t.id);

  // Players + scores across org
  const allPlayers = tournamentIds.length > 0
    ? await db.select().from(playersTable).where(inArray(playersTable.tournamentId, tournamentIds))
    : [];
  const playerIds = allPlayers.map(p => p.id);

  const allScores = playerIds.length > 0
    ? await db.select().from(scoresTable).where(inArray(scoresTable.playerId, playerIds))
    : [];

  // Build hole par maps per tournament
  const tournamentCourseMap = new Map<number, number>();
  for (const t of allTournaments) if (t.courseId) tournamentCourseMap.set(t.id, t.courseId);
  const uniqueCourseIds = [...new Set(tournamentCourseMap.values())];
  const courseHoleParMap = new Map<number, Map<number, number>>();
  for (const cid of uniqueCourseIds) {
    const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, cid));
    courseHoleParMap.set(cid, new Map(holes.map(h => [h.holeNumber, h.par])));
  }
  function getHP(tid: number, hn: number): number {
    const cid = tournamentCourseMap.get(tid);
    return cid ? (courseHoleParMap.get(cid)?.get(hn) ?? 4) : 4;
  }

  // Group scores by playerId+tournamentId+round to get round totals (tournamentId prevents cross-tournament collision)
  interface RoundKey { playerId: number; tournamentId: number; round: number }
  const roundMap = new Map<string, { key: RoundKey; scores: typeof allScores }>();
  for (const s of allScores) {
    const k = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!roundMap.has(k)) roundMap.set(k, { key: { playerId: s.playerId, tournamentId: s.tournamentId, round: s.round }, scores: [] });
    roundMap.get(k)!.scores.push(s);
  }
  const completedRounds = [...roundMap.values()].filter(r => r.scores.length >= 9);

  // Player stat aggregates (for leaderboards)
  type PlayerStat = {
    playerId: number; playerName: string; rounds: number; avgGross: number;
    eagles: number; birdies: number; fairwayPct: number | null; girPct: number | null; avgPutts: number | null;
  };
  const playerStatMap = new Map<number, PlayerStat>();
  for (const { key, scores } of completedRounds) {
    const player = allPlayers.find(p => p.id === key.playerId);
    if (!player) continue;
    if (!playerStatMap.has(key.playerId)) {
      playerStatMap.set(key.playerId, { playerId: key.playerId, playerName: `${player.firstName} ${player.lastName}`, rounds: 0, avgGross: 0, eagles: 0, birdies: 0, fairwayPct: null, girPct: null, avgPutts: null });
    }
    const ps = playerStatMap.get(key.playerId)!;
    const gross = scores.reduce((a, s) => a + s.strokes, 0);
    ps.avgGross = (ps.avgGross * ps.rounds + gross) / (ps.rounds + 1);
    ps.rounds++;
    ps.eagles += scores.filter(s => s.strokes - getHP(key.tournamentId, s.holeNumber) <= -2).length;
    ps.birdies += scores.filter(s => s.strokes - getHP(key.tournamentId, s.holeNumber) === -1).length;
  }

  // Sort leaderboards
  const playerStats = [...playerStatMap.values()].filter(p => p.rounds >= 1);
  const bestAvgGross = [...playerStats].sort((a, b) => a.avgGross - b.avgGross).slice(0, 10);
  const mostEagles = [...playerStats].sort((a, b) => b.eagles - a.eagles).slice(0, 10);
  const mostBirdies = [...playerStats].sort((a, b) => b.birdies - a.birdies).slice(0, 10);

  // Format popularity
  const formatCounts: Record<string, number> = {};
  for (const t of allTournaments) { formatCounts[t.format] = (formatCounts[t.format] ?? 0) + 1; }

  // Monthly player growth (last 12 months)
  const now = new Date();
  const monthlyGrowth = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    const nextD = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const count2 = allPlayers.filter(p => {
      const at = new Date(p.registeredAt);
      return at >= d && at < nextD;
    }).length;
    return { month: d.toISOString().slice(0, 7), players: count2 };
  });

  // Monthly revenue trend (last 12 months) — entry fees collected from paid players
  const tournamentFeeMap = new Map(allTournaments.map(t => [t.id, parseFloat(t.entryFee ?? "0")]));
  const monthlyRevenue = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    const nextD = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const revenue = allPlayers.filter(p => {
      if (p.paymentStatus !== "paid") return false;
      const at = new Date(p.registeredAt);
      return at >= d && at < nextD;
    }).reduce((sum, p) => sum + (tournamentFeeMap.get(p.tournamentId) ?? 0), 0);
    return { month: d.toISOString().slice(0, 7), revenue: Math.round(revenue * 100) / 100 };
  });

  // Player retention rate — % of unique players who appear in 2+ tournaments
  const playerTournamentMap = new Map<number, Set<number>>();
  for (const p of allPlayers) {
    if (!p.userId) continue;
    if (!playerTournamentMap.has(p.userId)) playerTournamentMap.set(p.userId, new Set());
    playerTournamentMap.get(p.userId)!.add(p.tournamentId);
  }
  const linkedPlayers = playerTournamentMap.size;
  const returnedPlayers = [...playerTournamentMap.values()].filter(s => s.size >= 2).length;
  const retentionRate = linkedPlayers > 0 ? Math.round((returnedPlayers / linkedPlayers) * 1000) / 10 : null;

  // Event participation rate by tournament
  const eventParticipation = allTournaments.slice(-12).map(t => {
    const playerCount = allPlayers.filter(p => p.tournamentId === t.id).length;
    const paidCount = allPlayers.filter(p => p.tournamentId === t.id && p.paymentStatus === "paid").length;
    return { tournamentId: t.id, name: t.name, format: t.format, players: playerCount, paidPlayers: paidCount, startDate: t.startDate };
  });

  // Streaks — players with most consecutive rounds scored
  // (simplified: just total rounds as proxy for consistency)
  const consistencyLeaders = [...playerStats].sort((a, b) => b.rounds - a.rounds).slice(0, 5).map(p => ({ playerName: p.playerName, rounds: p.rounds }));

  res.json({
    bestScoringAverage: bestAvgGross.map(p => ({ playerName: p.playerName, rounds: p.rounds, avgGross: Math.round(p.avgGross * 10) / 10 })),
    mostEagles: mostEagles.filter(p => p.eagles > 0).map(p => ({ playerName: p.playerName, eagles: p.eagles, rounds: p.rounds })),
    mostBirdies: mostBirdies.filter(p => p.birdies > 0).map(p => ({ playerName: p.playerName, birdies: p.birdies, rounds: p.rounds })),
    formatPopularity: Object.entries(formatCounts).sort((a, b) => b[1] - a[1]).map(([format, cnt]) => ({ format, count: cnt })),
    monthlyPlayerGrowth: monthlyGrowth,
    monthlyRevenue,
    retentionRate,
    eventParticipation,
    consistencyLeaders,
    totals: { tournaments: allTournaments.length, players: allPlayers.length, rounds: completedRounds.length, scores: allScores.length },
  });
});

/* ─── GHIN Credentials (org-scoped) ──────────────────────────────────────────
 *
 * GET  /:orgId/ghin-credentials  — Check if GHIN credentials are configured.
 *                                  Returns { configured: bool, hasOrgCredentials: bool, hasEnvCredentials: bool }
 *                                  NEVER returns the actual credentials.
 *
 * PUT  /:orgId/ghin-credentials  — Store or update encrypted GHIN credentials.
 *                                  Body: { apiKey, username, password }
 *                                  Admin only.
 *
 * DELETE /:orgId/ghin-credentials — Remove org GHIN credentials (fall back to env).
 *                                   Admin only.
 */

router.get("/:orgId/ghin-credentials", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [row] = await db
    .select({ id: orgGhinCredentialsTable.id })
    .from(orgGhinCredentialsTable)
    .where(eq(orgGhinCredentialsTable.organizationId, orgId));

  const hasOrgCredentials = !!row;
  const hasEnvCredentials = !!(process.env.GHIN_API_KEY && process.env.GHIN_API_USERNAME && process.env.GHIN_API_PASSWORD);
  const canStoreOrgCredentials = encryptionAvailable();

  res.json({
    configured: hasOrgCredentials || hasEnvCredentials,
    hasOrgCredentials,
    hasEnvCredentials,
    canStoreOrgCredentials,
  });
});

router.put("/:orgId/ghin-credentials", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  if (!encryptionAvailable()) {
    res.status(503).json({
      error: "ENCRYPTION_SECRET is not configured on this server. " +
        "GHIN credential storage requires an encryption key. " +
        "Ask your server administrator to set the ENCRYPTION_SECRET environment variable.",
    });
    return;
  }

  const { apiKey, username, password } = req.body;
  if (!apiKey || !username || !password) {
    res.status(400).json({ error: "apiKey, username, and password are required" });
    return;
  }

  const encApiKey = encrypt(String(apiKey).trim());
  const encUsername = encrypt(String(username).trim());
  const encPassword = encrypt(String(password).trim());

  const [row] = await db
    .insert(orgGhinCredentialsTable)
    .values({ organizationId: orgId, ghinApiKey: encApiKey, ghinApiUsername: encUsername, ghinApiPassword: encPassword })
    .onConflictDoUpdate({
      target: [orgGhinCredentialsTable.organizationId],
      set: { ghinApiKey: encApiKey, ghinApiUsername: encUsername, ghinApiPassword: encPassword, updatedAt: new Date() },
    })
    .returning({ id: orgGhinCredentialsTable.id });

  res.json({ ok: true, id: row?.id });
});

router.delete("/:orgId/ghin-credentials", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(orgGhinCredentialsTable).where(eq(orgGhinCredentialsTable.organizationId, orgId));
  res.json({ ok: true });
});

/* ─── POST /:orgId/ghin-credentials/test — verify GHIN club service token + count matched members */
router.post("/:orgId/ghin-credentials/test", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [credRow] = await db
    .select({ apiKey: orgGhinCredentialsTable.ghinApiKey, username: orgGhinCredentialsTable.ghinApiUsername, password: orgGhinCredentialsTable.ghinApiPassword })
    .from(orgGhinCredentialsTable)
    .where(eq(orgGhinCredentialsTable.organizationId, orgId));

  const rawCreds = credRow
    ? { apiKey: credRow.apiKey, username: credRow.username, password: credRow.password }
    : null;

  const creds = resolveGhinCredentials(rawCreds);
  if (!creds) {
    res.status(400).json({ success: false, error: "No GHIN credentials configured for this organization." });
    return;
  }

  try {
    // Step 1: Obtain a bearer token via GHIN user authentication
    const authRes = await fetch("https://api2.ghin.com/api/v1/users/sign_in.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: { email: creds.username, password: creds.password } }),
    });
    const authData = await authRes.json() as { token?: string; error?: string };

    if (!authRes.ok || !authData.token) {
      res.json({ success: false, error: "GHIN authentication failed. Check your username and password." });
      return;
    }

    const bearerToken = authData.token;

    // Step 2: Validate the club service API key by making a real call to the GHIN API.
    // We test the apiKey by calling the courses endpoint with both the bearer token and x-api-key header.
    // A valid club service token is required by GHIN for score posting — if the apiKey is wrong the
    // score posting calls will be rejected even if the username/password auth succeeded.
    const apiKeyTestRes = await fetch("https://api2.ghin.com/api/v1/courses.json?search_term=test&per_page=1", {
      headers: {
        "Authorization": `Bearer ${bearerToken}`,
        "x-api-key": creds.apiKey,
      },
    });

    // Any non-2xx from the GHIN API with these credentials means the club service token is rejected
    if (!apiKeyTestRes.ok) {
      const statusCode = apiKeyTestRes.status;
      const errMsg = statusCode === 401 || statusCode === 403
        ? "Club service API key is invalid or not authorized. Check your GHIN API key."
        : `GHIN API key validation failed (HTTP ${statusCode}). Verify your API key is correct.`;
      res.json({ success: false, error: errMsg });
      return;
    }

    // Step 3: Count club members who have a GHIN number registered locally
    const ghinRows = await db
      .selectDistinct({ ghinNumber: playersTable.ghinNumber })
      .from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(tournamentsTable.organizationId, orgId),
        isNotNull(playersTable.ghinNumber),
      ));

    const membersWithGhin = ghinRows.filter(r => r.ghinNumber && r.ghinNumber.trim()).length;

    res.json({
      success: true,
      message: "GHIN credentials verified successfully. Club service token accepted.",
      membersWithGhin,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    res.json({ success: false, error: `Connection test failed: ${msg}` });
  }
});

// GET /organizations/:orgId/plan — return plan status, usage, and limits for this org
router.get("/:orgId/plan", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const status = await getOrgPlanStatus(orgId);
  if (!status) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const tierDisplay = getTierDisplay(status.tier);
  const allTiers = (Object.entries(TIER_DISPLAY) as [SubscriptionTier, typeof TIER_DISPLAY[SubscriptionTier]][]).map(([t, d]) => ({
    tier: t,
    ...d,
    limits: TIER_LIMITS[t],
    current: t === status.tier,
  }));

  res.json({
    ...status,
    tierDisplay,
    allTiers,
  });
});

// Task #2068 — per-organization rollup of skipped/failed manual-entry
// alerts. Mirrors the super-admin rows endpoint but restricts the
// underlying query to the URL-param organization (any `organizationId`
// supplied in the query string is ignored — the route owns that scope).
//
// Auth: org_admin / tournament_director for the named org, an
// org_membership row with one of those roles, or platform super_admin.
// Anyone else gets 401/403 from `requireOrgAdmin` above.
router.get("/:orgId/manual-entry-alerts/rows", async (req: Request, res: Response) => {
  const orgId = Number(req.params.orgId);
  if (!Number.isFinite(orgId) || orgId <= 0) {
    res.status(400).json({ error: "Invalid orgId" });
    return;
  }
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const result = parseManualEntryAlertRowsQuery(req.query as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).json({ error: `Invalid value for ${result.field}` });
    return;
  }

  // Lock the organization scope to the URL param — never trust a query
  // string `organizationId` here, otherwise an org_admin could probe
  // sibling orgs by passing `?organizationId=999`.
  res.json(await listManualEntryAlertRows({
    ...result.parsed,
    organizationId: orgId,
  }));
});

export default router;
