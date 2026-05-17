import { db, shopOrdersTable, shopProductsTable, shopReviewPromptsTable, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendBroadcast } from "./comms";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "reviewPrompt" });

interface ReviewPromptOrder {
  id: number;
  userId: number | null;
  productId: number | null;
  organizationId: number;
  customerEmail: string | null;
  customerName: string;
}

/**
 * Enqueues a review prompt for the customer and sends a review invitation email.
 * Idempotent — if a prompt already exists for this user+order combination, no-ops silently
 * (the unique constraint on shop_review_prompts is (userId, orderId)).
 * Call this whenever an order reaches "shipped" or "delivered" status.
 */
export async function enqueueReviewPrompt(order: ReviewPromptOrder): Promise<void> {
  if (!order.userId || !order.productId) return;

  let promptEntry: typeof shopReviewPromptsTable.$inferSelect | undefined;
  try {
    const rows = await db.insert(shopReviewPromptsTable)
      .values({ userId: order.userId, orderId: order.id, productId: order.productId })
      .onConflictDoNothing()
      .returning();
    promptEntry = rows[0];
  } catch (err) {
    // onConflictDoNothing() handles uniqueness at the SQL level (no throw).
    // Any error reaching here is an unexpected DB failure (connection, timeout, etc.).
    logger.warn({ err, orderId: order.id }, "[reviewPrompt] Failed to enqueue review prompt — unexpected DB error");
    return;
  }

  // promptEntry is undefined when the row already existed (conflict was suppressed)
  if (!promptEntry || !order.customerEmail) return;

  try {
    const [prod] = await db.select({ name: shopProductsTable.name })
      .from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));
    const [org] = await db.select({ name: organizationsTable.name })
      .from(organizationsTable).where(eq(organizationsTable.id, order.organizationId));
    const shopBrand = org?.name ?? "KHARAGOLF";

    const parts = order.customerName.trim().split(/\s+/);
    const fName = parts[0] ?? order.customerName;
    const lName = parts.slice(1).join(" ") || "-";

    await sendBroadcast(
      [{ firstName: fName, lastName: lName, email: order.customerEmail }],
      {
        channels: ["email"],
        subject: "How did we do? Leave a review ⭐",
        body: `Hi ${fName},\n\nWe hope you're enjoying your ${prod?.name ?? "recent purchase"}!\n\nWe'd love to hear your thoughts — your review helps other ${shopBrand} members make great choices.\n\nSign in to your player portal to leave a review.\n\nThank you for being part of the club!`,
        eventName: "Club Shop Review",
        // Task #1566 — tag the review-invitation email with the originating
        // club so the Postmark bounce webhook (Task #981) attributes hard
        // bounces back to this org instantly instead of falling through to
        // the slow campaign / membership scan path.
        organizationId: order.organizationId,
      },
    );

    logger.info(
      { orderId: order.id, productId: order.productId, email: order.customerEmail },
      "[reviewPrompt] Review invitation sent",
    );
  } catch (err) {
    logger.warn({ err, orderId: order.id }, "[reviewPrompt] Failed to send review invitation email");
  }
}
