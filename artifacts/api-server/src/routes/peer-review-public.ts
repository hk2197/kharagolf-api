/**
 * Public peer-review response endpoint — token-authenticated, no session.
 * Mounted at /api/public/peer-review.
 *
 *   GET  /:token        Inspect the case for a peer reviewer
 *   POST /:token        Submit a peer recommendation + comment
 */
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  handicapCasePeerReviewsTable,
  handicapReviewCasesTable,
  appUsersTable,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { recordPeerResponse } from "../lib/handicap-cases";

const router: IRouter = Router();

router.get("/peer-review/:token", async (req: Request, res: Response) => {
  const token = String((req.params as Record<string, string>).token || "");
  if (!token) { { res.status(400).json({ error: "token required" }); return; } }

  const [row] = await db.select({
    p: handicapCasePeerReviewsTable,
    c: handicapReviewCasesTable,
    subjectName: appUsersTable.displayName,
    orgName: organizationsTable.name,
  })
    .from(handicapCasePeerReviewsTable)
    .innerJoin(handicapReviewCasesTable, eq(handicapCasePeerReviewsTable.caseId, handicapReviewCasesTable.id))
    .leftJoin(appUsersTable, eq(handicapReviewCasesTable.subjectUserId, appUsersTable.id))
    .leftJoin(organizationsTable, eq(handicapReviewCasesTable.organizationId, organizationsTable.id))
    .where(eq(handicapCasePeerReviewsTable.token, token));

  if (!row) { { res.status(404).json({ error: "Invalid or expired link" }); return; } }
  const expired = !!row.p.expiresAt && row.p.expiresAt < new Date();

  res.json({
    expired,
    alreadyResponded: !!row.p.respondedAt,
    invitedAt: row.p.invitedAt.toISOString(),
    respondedAt: row.p.respondedAt?.toISOString() ?? null,
    recommendation: row.p.recommendation,
    comment: row.p.comment,
    case: {
      kind: row.c.kind,
      status: row.c.status,
      details: row.c.details,
      periodLabel: row.c.periodLabel,
      subjectName: row.subjectName,
      orgName: row.orgName,
    },
  });
});

router.post("/peer-review/:token", async (req: Request, res: Response) => {
  const token = String((req.params as Record<string, string>).token || "");
  const { recommendation, comment } = req.body as { recommendation?: string; comment?: string };
  const allowed = ["confirm", "dispute", "insufficient_info"] as const;
  if (!recommendation || !(allowed as readonly string[]).includes(recommendation)) {
    res.status(400).json({ error: `recommendation must be one of: ${allowed.join(", ")}` }); return;
  }
  const result = await recordPeerResponse({
    token,
    recommendation: recommendation as typeof allowed[number],
    comment: typeof comment === "string" && comment.trim().length > 0 ? comment.trim() : null,
  });
  if (!result) { { res.status(404).json({ error: "Invalid or expired peer review link" }); return; } }
  res.json({ success: true, caseId: result.caseId });
});

export default router;
