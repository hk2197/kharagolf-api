/**
 * Task #500 — Integration test for the POS hardcoded-rate fallback path.
 *
 * The POS sales endpoint (POST /api/organizations/:orgId/pos/transactions)
 * back-derives an inclusive GST/VAT rate from `resolveOrgTaxes` so that
 * non-Indian clubs route through the correct VAT/sales-tax profile, with
 * a hardcoded 18% fallback preserved for the "tax engine threw" case.
 *
 * This test forces `resolveOrgTaxes` to throw and asserts:
 *   - The route still completes the sale (the fallback is non-blocking).
 *   - The persisted transaction's tax amount equals subtotal * 18 / 118
 *     (i.e. 18% inclusive on a 100-unit subtotal → 15.25 tax).
 *
 * `getOrgCurrencyContext` is left intact so the surrounding routing-lookup
 * code in pos.ts still functions normally.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../lib/checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/checkout")>();
  return {
    ...actual,
    resolveOrgTaxes: vi.fn(async () => {
      throw new Error("simulated tax engine outage (Task #500 fallback test)");
    }),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  posTransactionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
let orgId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `PosFallbackTest_${stamp}`,
    slug: `pos-fallback-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `pos-fallback-${stamp}`,
    username: `pos_fallback_${stamp}`,
    email: `pos_fallback_${stamp}@example.com`,
    displayName: "POS Fallback Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: user.id,
    role: "org_admin",
  });

  admin = {
    id: user.id,
    username: `pos_fallback_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

describe("POS tax engine fallback (Task #500)", () => {
  it("falls back to the hardcoded 18% inclusive rate when resolveOrgTaxes throws", async () => {
    const subtotal = 100;
    // 18% inclusive: tax = subtotal * 18 / (100 + 18) = 15.25 (rounded to 2dp).
    const expectedTax = +((subtotal * 18) / 118).toFixed(2);

    const res = await request(app)
      .post(`/api/organizations/${orgId}/pos/transactions`)
      .send({
        paymentMethod: "cash",
        items: [
          {
            productName: "Range Balls (50)",
            quantity: 1,
            unitPrice: subtotal,
            category: "general",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(parseFloat(res.body.subtotal)).toBe(subtotal);
    expect(parseFloat(res.body.taxAmount)).toBe(expectedTax);
    expect(parseFloat(res.body.totalAmount)).toBe(subtotal);

    // Sanity-check that the persisted row also reflects the fallback rate.
    const [persisted] = await db.select({
      tax: posTransactionsTable.taxAmount,
    }).from(posTransactionsTable).where(eq(posTransactionsTable.id, res.body.id));
    expect(parseFloat(persisted.tax)).toBe(expectedTax);
  });
});
