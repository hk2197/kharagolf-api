/**
 * Outbound Webhook Management API (Task #149)
 *
 * Routes (all scoped to /organizations/:orgId/webhooks):
 *   GET    /                   - List all webhook endpoints
 *   POST   /                   - Create webhook endpoint
 *   GET    /:endpointId        - Get single endpoint
 *   PUT    /:endpointId        - Update endpoint
 *   DELETE /:endpointId        - Delete endpoint
 *   PATCH  /:endpointId/toggle - Toggle active/inactive
 *   POST   /:endpointId/regenerate-secret - Rotate HMAC secret
 *   GET    /:endpointId/logs   - Delivery log (last 50)
 *   POST   /:endpointId/test   - Send test delivery
 *   GET    /events             - List available event types
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "crypto";
import { db, webhookEndpointsTable, webhookDeliveryLogTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { orgAdminMiddleware } from "../lib/permissions";
import { sendTestDelivery, WEBHOOK_EVENT_TYPES } from "../lib/webhookDispatch";
import { logger as baseLogger } from "../lib/logger";

const logger = baseLogger.child({ module: "outbound-webhooks" });

const router: IRouter = Router({ mergeParams: true });

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

const VALID_EVENT_SET = new Set<string>(WEBHOOK_EVENT_TYPES);

function validateEvents(events: string[]): { invalid: string[] } {
  return { invalid: events.filter(e => !VALID_EVENT_SET.has(e)) };
}

// All routes require org admin
router.use(orgAdminMiddleware);

// GET /organizations/:orgId/webhooks/events
router.get("/events", (_req: Request, res: Response) => {
  res.json({ events: WEBHOOK_EVENT_TYPES });
});

// GET /organizations/:orgId/webhooks
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpoints = await db
    .select()
    .from(webhookEndpointsTable)
    .where(eq(webhookEndpointsTable.organizationId, orgId))
    .orderBy(webhookEndpointsTable.createdAt);
  res.json(endpoints);
});

// POST /organizations/:orgId/webhooks
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { name, url, subscribedEvents } = req.body as {
    name?: string;
    url?: string;
    subscribedEvents?: string[];
  };

  if (!name || !url) {
    res.status(400).json({ error: "name and url are required" });
    return;
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    res.status(400).json({ error: "url must be a valid HTTP/HTTPS URL" });
    return;
  }

  const events = Array.isArray(subscribedEvents) ? subscribedEvents : [];
  const { invalid } = validateEvents(events);
  if (invalid.length > 0) {
    res.status(400).json({ error: `Unknown event type(s): ${invalid.join(", ")}. Valid events: ${WEBHOOK_EVENT_TYPES.join(", ")}` });
    return;
  }

  const secret = generateSecret();

  const [endpoint] = await db
    .insert(webhookEndpointsTable)
    .values({
      organizationId: orgId,
      name,
      url,
      secret,
      subscribedEvents: events,
      isActive: true,
    })
    .returning();

  logger.info({ orgId, endpointId: endpoint.id }, "[outbound-webhooks] Endpoint created");
  res.status(201).json(endpoint);
});

// GET /organizations/:orgId/webhooks/:endpointId
router.get("/:endpointId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  const [endpoint] = await db
    .select()
    .from(webhookEndpointsTable)
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ));

  if (!endpoint) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }
  res.json(endpoint);
});

// PUT /organizations/:orgId/webhooks/:endpointId
router.put("/:endpointId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));
  const { name, url, subscribedEvents, isActive } = req.body as {
    name?: string;
    url?: string;
    subscribedEvents?: string[];
    isActive?: boolean;
  };

  if (!name || !url) {
    res.status(400).json({ error: "name and url are required" });
    return;
  }

  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    res.status(400).json({ error: "url must be a valid HTTP/HTTPS URL" });
    return;
  }

  const events = Array.isArray(subscribedEvents) ? subscribedEvents : [];
  const { invalid: invalidPut } = validateEvents(events);
  if (invalidPut.length > 0) {
    res.status(400).json({ error: `Unknown event type(s): ${invalidPut.join(", ")}. Valid events: ${WEBHOOK_EVENT_TYPES.join(", ")}` });
    return;
  }

  const [endpoint] = await db
    .update(webhookEndpointsTable)
    .set({
      name,
      url,
      subscribedEvents: events,
      ...(typeof isActive === "boolean" ? { isActive } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ))
    .returning();

  if (!endpoint) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }
  res.json(endpoint);
});

// DELETE /organizations/:orgId/webhooks/:endpointId
router.delete("/:endpointId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  await db
    .delete(webhookEndpointsTable)
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ));

  logger.info({ orgId, endpointId }, "[outbound-webhooks] Endpoint deleted");
  res.status(204).send();
});

// PATCH /organizations/:orgId/webhooks/:endpointId/toggle
router.patch("/:endpointId/toggle", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  const [current] = await db
    .select({ isActive: webhookEndpointsTable.isActive })
    .from(webhookEndpointsTable)
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ));

  if (!current) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }

  const [endpoint] = await db
    .update(webhookEndpointsTable)
    .set({ isActive: !current.isActive, updatedAt: new Date() })
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ))
    .returning();

  res.json(endpoint);
});

// POST /organizations/:orgId/webhooks/:endpointId/regenerate-secret
router.post("/:endpointId/regenerate-secret", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  const newSecret = generateSecret();

  const [endpoint] = await db
    .update(webhookEndpointsTable)
    .set({ secret: newSecret, updatedAt: new Date() })
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ))
    .returning();

  if (!endpoint) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }

  logger.info({ orgId, endpointId }, "[outbound-webhooks] Secret regenerated");
  res.json({ secret: newSecret, endpoint });
});

// GET /organizations/:orgId/webhooks/:endpointId/logs
router.get("/:endpointId/logs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  const [endpoint] = await db
    .select({ id: webhookEndpointsTable.id })
    .from(webhookEndpointsTable)
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ));

  if (!endpoint) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }

  const logs = await db
    .select()
    .from(webhookDeliveryLogTable)
    .where(eq(webhookDeliveryLogTable.endpointId, endpointId))
    .orderBy(desc(webhookDeliveryLogTable.createdAt))
    .limit(50);

  res.json(logs);
});

// POST /organizations/:orgId/webhooks/:endpointId/test
router.post("/:endpointId/test", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const endpointId = parseInt(String((req.params as Record<string, string>).endpointId));

  const [endpoint] = await db
    .select()
    .from(webhookEndpointsTable)
    .where(and(
      eq(webhookEndpointsTable.id, endpointId),
      eq(webhookEndpointsTable.organizationId, orgId),
    ));

  if (!endpoint) { { res.status(404).json({ error: "Webhook endpoint not found" }); return; } }

  const result = await sendTestDelivery(endpointId, endpoint.url, endpoint.secret, orgId);
  res.json(result);
});

export default router;
