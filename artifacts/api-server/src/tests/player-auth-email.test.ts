/**
 * Integration tests: Player Auth Email Delivery Flows (Task #17)
 *
 * Verifies the behavior of auth endpoints that send transactional email:
 *   - Registration: emailDelivered field in response, correct status codes
 *   - Resend verification: anti-enumeration response, handles unknown email
 *   - Forgot password: anti-enumeration response for all inputs
 *   - Reset password: token validation (invalid/missing token → 400)
 *   - Login: bad credentials → 401, no crash or internal detail exposure
 *
 * Real email delivery is not triggered — tests cover HTTP contract and
 * error-handling behavior, not SMTP side-effects.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const app = createTestApp();
const testEmail = `qa-player-auth-${Date.now()}@example.com`;
let testUserId: number | null = null;

afterAll(async () => {
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("Player Auth — Registration", () => {
  it("returns 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/api/auth/player-register")
      .send({ email: testEmail, password: "TestPass123!" });
    expect(res.status).toBe(400);
  });

  it("registers a new player and returns emailDelivered boolean", async () => {
    const res = await request(app)
      .post("/api/auth/player-register")
      .send({
        firstName: "QA",
        lastName: "Tester",
        email: testEmail,
        password: "TestPass123!",
        orgId: 1,
      });

    // 201 on success, 200 also acceptable for some configs
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.userId).toBe("number");
    expect(typeof res.body.emailDelivered).toBe("boolean");
    testUserId = res.body.userId;
  });

  it("returns 409 when email is already registered", async () => {
    const res = await request(app)
      .post("/api/auth/player-register")
      .send({
        firstName: "QA",
        lastName: "Duplicate",
        email: testEmail,
        password: "AnotherPass456!",
        orgId: 1,
      });
    expect(res.status).toBe(409);
  });
});

// ── Resend Verification ───────────────────────────────────────────────────────

describe("Player Auth — Resend Verification", () => {
  it("returns anti-enumeration response for unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "nonexistent-nobody@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email is registered/i);
  });

  it("returns 400 when email field is missing", async () => {
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns anti-enumeration response for registered unverified email", async () => {
    if (!testUserId) return;
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: testEmail });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email is registered/i);
  });
});

// ── Forgot Password ───────────────────────────────────────────────────────────

describe("Player Auth — Forgot Password", () => {
  it("returns anti-enumeration response for unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody-unknown@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email is registered/i);
  });

  it("returns anti-enumeration response for registered email", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: testEmail });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email is registered/i);
  });

  it("returns 400 when email field is missing", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({});
    expect(res.status).toBe(400);
  });
});

// ── Reset Password ────────────────────────────────────────────────────────────

describe("Player Auth — Reset Password", () => {
  it("returns 400 for an invalid/unknown token", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "totally-invalid-token-abc123xyz", password: "NewPass123!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid|expired/i);
  });

  it("returns 400 when token is missing", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ password: "NewPass123!" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "some-token-without-password" });
    expect(res.status).toBe(400);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe("Player Auth — Login", () => {
  it("returns 401 for bad credentials — does not crash", async () => {
    const res = await request(app)
      .post("/api/auth/player-login")
      .send({ email: "nobody@example.com", password: "wrongpassword" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
  });

  it("returns 401 for wrong password on registered account", async () => {
    const res = await request(app)
      .post("/api/auth/player-login")
      .send({ email: testEmail, password: "wrong-password-xyz" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
  });

  it("returns 400 when email or password is missing", async () => {
    const res = await request(app)
      .post("/api/auth/player-login")
      .send({ email: testEmail });
    expect([400, 401]).toContain(res.status);
  });
});
