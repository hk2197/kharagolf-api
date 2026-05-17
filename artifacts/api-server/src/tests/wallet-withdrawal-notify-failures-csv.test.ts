/**
 * Integration test: CSV export of the stuck wallet-withdrawal alert
 * worklist (Task #1844).
 *
 * Covers GET /api/admin/wallet-withdrawal-notify-failures.csv. The
 * sibling JSON endpoint already has filter/pagination coverage in
 * `wallet-withdrawal-notify-failures-admin.test.ts`; this file pins
 * the CSV-specific contract:
 *   - Auth gating mirrors the JSON endpoint (org admin only).
 *   - Pagination is dropped — every matching row is in the download.
 *   - One row per *stuck channel*, so an attempt with both email and
 *     push stuck emits two rows (each with its own attempts/last
 *     error/last attempt timestamp).
 *   - Filter parity: channel/state/q narrow the export the same way
 *     they narrow the JSON list.
 *   - Response sets Content-Type and a download Content-Disposition.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubWalletsTable,
  clubWalletWithdrawalsTable,
  walletWithdrawalNotifyAttemptsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let testOrgId: number;
let testWalletId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;

const withdrawalIds: number[] = [];
const attemptIds: number[] = [];
const userIds: number[] = [];
let seq = 0;

async function makeUser(overrides: {
  username?: string;
  displayName?: string | null;
  email?: string | null;
} = {}): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wd-csv-${tag}`,
    username: overrides.username ?? `wd_csv_${tag}`,
    displayName: overrides.displayName ?? null,
    email: overrides.email ?? null,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeWithdrawal(userId: number, opts: {
  amount?: string;
} = {}): Promise<number> {
  const [w] = await db.insert(clubWalletWithdrawalsTable).values({
    walletId: testWalletId,
    organizationId: testOrgId,
    userId,
    amount: opts.amount ?? "250.00",
    currency: "INR",
    method: "upi",
    status: "processed",
  }).returning({ id: clubWalletWithdrawalsTable.id });
  withdrawalIds.push(w.id);
  return w.id;
}

async function makeAttempt(opts: {
  withdrawalId: number;
  userId: number;
  amount?: string;
  emailStatus?: string | null;
  emailAttempts?: number;
  emailRetryExhaustedAt?: Date | null;
  lastEmailError?: string | null;
  lastEmailAt?: Date | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  pushRetryExhaustedAt?: Date | null;
  lastPushError?: string | null;
  lastPushAt?: Date | null;
}): Promise<number> {
  const [a] = await db.insert(walletWithdrawalNotifyAttemptsTable).values({
    withdrawalId: opts.withdrawalId,
    organizationId: testOrgId,
    userId: opts.userId,
    outcome: "processed",
    amount: opts.amount ?? "250.00",
    currency: "INR",
    destination: "UPI ****1234",
    emailStatus: opts.emailStatus ?? "sent",
    emailAttempts: opts.emailAttempts ?? 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    lastEmailError: opts.lastEmailError ?? null,
    lastEmailAt: opts.lastEmailAt ?? null,
    pushStatus: opts.pushStatus ?? "sent",
    pushAttempts: opts.pushAttempts ?? 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
    lastPushError: opts.lastPushError ?? null,
    lastPushAt: opts.lastPushAt ?? null,
  }).returning({ id: walletWithdrawalNotifyAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WdCsv_${stamp}`,
    slug: `test-wd-csv-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const adminId = await makeUser({ username: `wd_csv_admin_${stamp}` });
  admin = {
    id: adminId,
    username: "admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);

  const nonAdminId = await makeUser({ username: `wd_csv_player_${stamp}` });
  nonAdminApp = createTestApp({
    id: nonAdminId,
    username: "member",
    role: "player",
    organizationId: testOrgId,
  });

  const walletOwnerId = await makeUser({ username: `wd_csv_wallet_${stamp}` });
  const [wallet] = await db.insert(clubWalletsTable).values({
    organizationId: testOrgId,
    userId: walletOwnerId,
    currency: "INR",
    balance: "0.00",
  }).returning({ id: clubWalletsTable.id });
  testWalletId = wallet.id;
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.id, testWalletId));
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  for (const id of attemptIds.splice(0)) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds.splice(0)) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
});

function parseCsv(body: string): string[][] {
  // Tiny tolerant parser — every cell in this endpoint is wrapped in
  // double quotes with internal `"` doubled, joined by `,` and `\n`.
  // Good enough for assertion-time parsing in the test suite.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i += 1; }
        else { inQuotes = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n") {
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("GET /api/admin/wallet-withdrawal-notify-failures.csv", () => {
  it("requires organizationId", async () => {
    const res = await request(app).get("/api/admin/wallet-withdrawal-notify-failures.csv");
    expect(res.status).toBe(400);
  });

  it("rejects non-admins with 403", async () => {
    const res = await request(nonAdminApp)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}`);
    expect(res.status).toBe(403);
  });

  it("sends a CSV download with the expected headers and ignores happy rows", async () => {
    const recipient = await makeUser({
      username: `csv_alice_${seq}`,
      displayName: "Alice CSV",
      email: "alice.csv@example.com",
    });

    const happyWd = await makeWithdrawal(recipient);
    await makeAttempt({ withdrawalId: happyWd, userId: recipient });

    const stuckWd = await makeWithdrawal(recipient, { amount: "1234.50" });
    await makeAttempt({
      withdrawalId: stuckWd,
      userId: recipient,
      amount: "1234.50",
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date("2026-04-25T10:05:00.000Z"),
      lastEmailError: "bounced",
      lastEmailAt: new Date("2026-04-25T10:05:00.000Z"),
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(
      new RegExp(`wallet-stuck-alerts-${testOrgId}\\.csv`),
    );

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "created_at",
      "recipient_name",
      "recipient_email",
      "withdrawal_id",
      "amount",
      "currency",
      "channel",
      "state",
      "attempts",
      "last_error",
      "last_attempt_at",
    ]);
    // Only the stuck row should be present — happy attempts never
    // emit a CSV line.
    const dataRows = rows.slice(1);
    expect(dataRows).toHaveLength(1);
    const [data] = dataRows;
    expect(data[1]).toBe("Alice CSV");
    expect(data[2]).toBe("alice.csv@example.com");
    expect(data[3]).toBe(String(stuckWd));
    expect(data[4]).toBe("1234.50");
    expect(data[5]).toBe("INR");
    expect(data[6]).toBe("email");
    expect(data[7]).toBe("exhausted");
    expect(data[8]).toBe("5");
    expect(data[9]).toBe("bounced");
    expect(data[10]).toBe("2026-04-25T10:05:00.000Z");
  });

  it("emits one row per stuck channel when both email and push are stuck", async () => {
    const recipient = await makeUser();
    const wd = await makeWithdrawal(recipient);
    await makeAttempt({
      withdrawalId: wd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
      lastEmailError: "smtp 5xx",
      pushStatus: "no_address",
      pushAttempts: 0,
      lastPushError: null,
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}`);
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text).slice(1);
    expect(rows).toHaveLength(2);
    const channels = rows.map(r => r[6]).sort();
    expect(channels).toEqual(["email", "push"]);
    const emailRow = rows.find(r => r[6] === "email")!;
    const pushRow = rows.find(r => r[6] === "push")!;
    expect(emailRow[7]).toBe("exhausted");
    expect(emailRow[9]).toBe("smtp 5xx");
    expect(pushRow[7]).toBe("skipped");
    expect(pushRow[8]).toBe("0");
  });

  it("filters by channel — push alone hides email-only stuck rows", async () => {
    const recipient = await makeUser();

    const emailOnlyWd = await makeWithdrawal(recipient);
    await makeAttempt({
      withdrawalId: emailOnlyWd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const pushOnlyWd = await makeWithdrawal(recipient);
    await makeAttempt({
      withdrawalId: pushOnlyWd,
      userId: recipient,
      pushStatus: "no_address",
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}&channel=push`);
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(String(pushOnlyWd));
    expect(rows[0][6]).toBe("push");
  });

  it("filters by state=skipped and only emits the skipped channel rows", async () => {
    const recipient = await makeUser();

    // Mixed attempt: email exhausted + push skipped. With state=skipped,
    // the JSON endpoint already filters this whole record out (because
    // it requires *neither* channel to be exhausted). So this row must
    // not appear in the CSV either.
    const mixedWd = await makeWithdrawal(recipient);
    await makeAttempt({
      withdrawalId: mixedWd,
      userId: recipient,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
      pushStatus: "no_address",
    });

    // Pure-skipped attempt: only push skipped, email is fine.
    const skippedWd = await makeWithdrawal(recipient);
    await makeAttempt({
      withdrawalId: skippedWd,
      userId: recipient,
      pushStatus: "no_address",
      lastPushError: "no device token",
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}&state=skipped`);
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe(String(skippedWd));
    expect(rows[0][6]).toBe("push");
    expect(rows[0][7]).toBe("skipped");
    expect(rows[0][9]).toBe("no device token");
  });

  it("recipient search narrows the export the same way the JSON list does", async () => {
    const seqTag = `${Date.now()}_csvsearch_${Math.floor(Math.random() * 1e6)}`;
    const aliceId = await makeUser({
      username: `csv_searchable_alice_${seqTag}`,
      displayName: "Alice Searchable",
      email: `alice_${seqTag}@example.com`,
    });
    const aliceWd = await makeWithdrawal(aliceId);
    await makeAttempt({
      withdrawalId: aliceWd,
      userId: aliceId,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    const otherId = await makeUser();
    const otherWd = await makeWithdrawal(otherId);
    await makeAttempt({
      withdrawalId: otherWd,
      userId: otherId,
      pushStatus: "no_address",
    });

    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}&q=ALICE`);
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe("Alice Searchable");
    expect(rows[0][3]).toBe(String(aliceWd));
  });

  it("CSV export is not paginated — rows beyond the page size are still included", async () => {
    const recipient = await makeUser();
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const wd = await makeWithdrawal(recipient);
      ids.push(await makeAttempt({
        withdrawalId: wd,
        userId: recipient,
        emailStatus: "no_address",
      }));
    }

    // Even when the caller passes limit/offset (the JSON endpoint
    // honours these), the CSV ignores them entirely.
    const res = await request(app)
      .get(`/api/admin/wallet-withdrawal-notify-failures.csv?organizationId=${testOrgId}&limit=2&offset=0`);
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text).slice(1);
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row[6]).toBe("email");
      expect(row[7]).toBe("skipped");
    }
  });
});
