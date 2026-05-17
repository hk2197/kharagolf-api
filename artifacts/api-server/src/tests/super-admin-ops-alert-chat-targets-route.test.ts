/**
 * Route-layer tests for GET /super-admin/ops-alert-settings/chat-targets
 * (Task #2055).
 *
 * The unit-level shape of the resolver is covered by tests on
 * `resolveOpsAlertChatTargetsStatus` itself; this file exercises the
 * HTTP boundary the super-admin Ops Alert card talks to:
 *
 *   - 401/403 gating (super_admin only — secret presence is sensitive
 *     even when values are sanitised away)
 *   - dedicated env var beats shared fallback (per channel, per flow)
 *   - shared fallback fills in when the dedicated var is unset
 *   - missing channels report `status: "missing"` with `source: null`
 *     and surface the env var name the admin needs to set
 *   - the response NEVER contains the secret webhook URL or routing
 *     key — only the env var NAMES + presence flag
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { db, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let superAdminUserId: number;
let nonAdminUserId: number;
const tag = `ops-chat-targets-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const SECRET_SLACK = "https://hooks.slack.com/services/T0/B0/PLEASE-DO-NOT-LEAK";
const SECRET_PD = "ROUTING-KEY-MUST-NEVER-LEAK-1234567890";

const ENV_KEYS = [
  "OPS_ALERT_SLACK_WEBHOOK",
  "OPS_ALERT_PAGERDUTY_ROUTING_KEY",
  "OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK",
  "OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
  "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
  "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  const [su] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `${tag}-su`,
      username: `${tag}-su`,
      email: `${tag}-su@example.com`,
      role: "super_admin",
      displayName: "Chat Targets Route Tester",
    })
    .returning({ id: appUsersTable.id });
  superAdminUserId = su.id;

  const [nu] = await db
    .insert(appUsersTable)
    .values({
      replitUserId: `${tag}-nu`,
      username: `${tag}-nu`,
      email: `${tag}-nu@example.com`,
      role: "player",
    })
    .returning({ id: appUsersTable.id });
  nonAdminUserId = nu.id;
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await db.delete(appUsersTable).where(eq(appUsersTable.id, superAdminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, nonAdminUserId));
});

beforeEach(() => {
  clearEnv();
});

afterEach(() => {
  clearEnv();
});

function asSuperAdmin() {
  return createTestApp({
    id: superAdminUserId,
    username: `${tag}-su`,
    role: "super_admin",
  });
}

describe("GET /api/super-admin/ops-alert-settings/chat-targets (Task #2055)", () => {
  it("rejects unauthenticated and non-super-admin callers", async () => {
    const anon = createTestApp();
    const r1 = await request(anon).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect([401, 403]).toContain(r1.status);

    const member = createTestApp({
      id: nonAdminUserId,
      username: `${tag}-nu`,
      role: "member",
    });
    const r2 = await request(member).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect([401, 403]).toContain(r2.status);
  });

  it("returns missing/null per channel when no env vars are set", async () => {
    const res = await request(asSuperAdmin()).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect(res.status).toBe(200);

    const flows = res.body.flows;
    expect(flows.notifyRetryExhaustion).toEqual({
      slack: {
        status: "missing",
        source: null,
        dedicatedEnvVar: "OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK",
        sharedEnvVar: "OPS_ALERT_SLACK_WEBHOOK",
      },
      pagerDuty: {
        status: "missing",
        source: null,
        dedicatedEnvVar: "OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY",
        sharedEnvVar: "OPS_ALERT_PAGERDUTY_ROUTING_KEY",
      },
    });
    expect(flows.watchGps).toEqual({
      slack: {
        status: "missing",
        source: null,
        dedicatedEnvVar: "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
        sharedEnvVar: "OPS_ALERT_SLACK_WEBHOOK",
      },
      pagerDuty: {
        status: "missing",
        source: null,
        dedicatedEnvVar: "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
        sharedEnvVar: "OPS_ALERT_PAGERDUTY_ROUTING_KEY",
      },
    });
  });

  it("reports source=shared when only the shared fallback is set", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = SECRET_SLACK;
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = SECRET_PD;

    const res = await request(asSuperAdmin()).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect(res.status).toBe(200);

    for (const flow of ["notifyRetryExhaustion", "watchGps"] as const) {
      expect(res.body.flows[flow].slack.status).toBe("configured");
      expect(res.body.flows[flow].slack.source).toBe("shared");
      expect(res.body.flows[flow].pagerDuty.status).toBe("configured");
      expect(res.body.flows[flow].pagerDuty.source).toBe("shared");
    }
  });

  it("reports source=dedicated when the per-flow var is set (and beats the shared fallback)", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = SECRET_SLACK;
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = SECRET_PD;
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = `${SECRET_SLACK}-DEDICATED-SLACK`;
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = `${SECRET_PD}-DEDICATED-PD`;

    const res = await request(asSuperAdmin()).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect(res.status).toBe(200);

    expect(res.body.flows.notifyRetryExhaustion.slack.source).toBe("dedicated");
    expect(res.body.flows.notifyRetryExhaustion.pagerDuty.source).toBe("dedicated");
    // Watch GPS still resolves via the shared fallback because we did
    // NOT set its dedicated env vars.
    expect(res.body.flows.watchGps.slack.source).toBe("shared");
    expect(res.body.flows.watchGps.pagerDuty.source).toBe("shared");
  });

  it("treats whitespace-only env var values as missing (defensive)", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = "   \n\t  ";
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "";

    const res = await request(asSuperAdmin()).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect(res.status).toBe(200);
    expect(res.body.flows.notifyRetryExhaustion.slack.status).toBe("missing");
    expect(res.body.flows.notifyRetryExhaustion.pagerDuty.status).toBe("missing");
  });

  it("never returns the webhook URL or routing key value in the response payload", async () => {
    process.env.OPS_ALERT_SLACK_WEBHOOK = SECRET_SLACK;
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = SECRET_PD;
    process.env.OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK = `${SECRET_SLACK}-DEDICATED-SLACK`;
    process.env.OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = `${SECRET_PD}-DEDICATED-PD`;
    process.env.OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK = `${SECRET_SLACK}-WATCH-SLACK`;
    process.env.OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY = `${SECRET_PD}-WATCH-PD`;

    const res = await request(asSuperAdmin()).get("/api/super-admin/ops-alert-settings/chat-targets");
    expect(res.status).toBe(200);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(SECRET_SLACK);
    expect(serialised).not.toContain(SECRET_PD);
    expect(serialised).not.toContain("hooks.slack.com");
    expect(serialised).not.toContain("ROUTING-KEY");
  });
});
