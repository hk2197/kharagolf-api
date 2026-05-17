/**
 * Member 360 audit-trail helper.
 * Records mutations to member-related entities with actor + before/after diff.
 */
import type { Request } from "express";
import { db } from "@workspace/db";
import { memberAuditLogTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export function diffObjects(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  ignore: string[] = ["updatedAt", "createdAt"],
): FieldChanges {
  const changes: FieldChanges = {};
  const keys = new Set<string>([
    ...(before ? Object.keys(before) : []),
    ...(after ? Object.keys(after) : []),
  ]);
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    const a = before?.[key];
    const b = after?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes[key] = { from: a ?? null, to: b ?? null };
    }
  }
  return changes;
}

interface AuditOpts {
  /** null when the audit is recorded by an unauthenticated/system context (e.g. webhook). */
  req: Request | null;
  organizationId: number;
  /** null = org-level audit (e.g. levy definition, saved segment) */
  clubMemberId: number | null;
  entity: string;
  entityId?: number | null;
  action: "create" | "update" | "delete" | "view_pii" | string;
  changes?: FieldChanges;
  /** Convenience: pass `after` and we record it in fieldChanges as create-style entries */
  after?: Record<string, unknown>;
  /** Convenience: pass `before` for delete-style entries */
  before?: Record<string, unknown>;
  reason?: string;
  /** Free-form structured detail for actions where `reason` text is too lossy
   * (e.g. resend audits store per-channel { status, at, error } objects so the
   * UI can render hover tooltips). */
  metadata?: Record<string, unknown>;
}

/**
 * Returns the inserted audit row id when the insert succeeds, or `null`
 * if the underlying DB call fails. Callers that don't need the id can
 * (and historically do) ignore the return value — audit failures are
 * deliberately silent so they never derail the primary operation.
 *
 * Task #1932 added the return value so the marketing suppression-reenable
 * handler can capture the per-member audit-row id and bake it into the
 * stateless dispute token issued to the affected member. The dispute /
 * revert endpoints later use that id to (a) link the dispute back to the
 * exact original re-enable in the audit trail and (b) dedup repeated
 * dispute presses against the same change.
 */
export async function recordMemberAudit(opts: AuditOpts): Promise<number | null> {
  const user = (opts.req?.user ?? undefined) as { id?: number; role?: string; displayName?: string; email?: string } | undefined;
  let actorName: string | null = user?.displayName ?? user?.email ?? null;
  if (!actorName && user?.id) {
    const [u] = await db.select({ displayName: appUsersTable.displayName, email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, user.id));
    actorName = u?.displayName ?? u?.email ?? null;
  }
  if (!actorName && !user?.id) {
    actorName = "system";
  }
  // Compute fieldChanges from before/after if provided
  let changes = opts.changes;
  if (!changes && (opts.before || opts.after)) {
    changes = diffObjects(opts.before, opts.after);
  }
  try {
    const [row] = await db.insert(memberAuditLogTable).values({
      organizationId: opts.organizationId,
      clubMemberId: opts.clubMemberId ?? null,
      actorUserId: user?.id ?? null,
      actorName,
      actorRole: user?.role ?? null,
      entity: opts.entity,
      entityId: opts.entityId ?? null,
      action: opts.action,
      fieldChanges: changes && Object.keys(changes).length > 0 ? changes : null,
      reason: opts.reason ?? null,
      metadata: opts.metadata ?? null,
      ipAddress: (opts.req?.ip ?? opts.req?.headers?.["x-forwarded-for"] ?? null) as string | null,
      userAgent: (opts.req?.headers?.["user-agent"] as string | undefined) ?? null,
    }).returning({ id: memberAuditLogTable.id });
    return row?.id ?? null;
  } catch (err) {
    // Audit failures must never break the primary operation
    console.error("[audit] failed to record member audit", err);
    return null;
  }
}
