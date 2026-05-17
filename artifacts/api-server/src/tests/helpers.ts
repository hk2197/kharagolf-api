/**
 * Test helpers — builds a lightweight Express app with optional user injection.
 * Bypasses OIDC session management so tests can run without a live Replit Auth server.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import router from "../routes/index.js";

export interface TestUser {
  id: number;
  username: string;
  displayName?: string;
  role: string;
  organizationId?: number | null;
  /** Mirrors the underlying `app_users.replit_user_id` column for tests
   *  that build a TestUser straight from a freshly inserted row. */
  replitUserId?: string;
}

/**
 * Build a test Express app. If `user` is provided it is injected into every
 * request so auth-protected routes treat the caller as authenticated.
 */
export function createTestApp(user?: TestUser) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // Task #2020 — mounted in real `app.ts`; required for the email CTA
  // redirect handler's `res.cookie()` round-trip and for the conversion
  // attribution helper to read `req.cookies[kg_email_click]`.
  app.use(cookieParser());

  // Inject authentication state
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      req.user = user as Express.User;
    }
    // Always attach isAuthenticated helper
    req.isAuthenticated = function (this: Request) {
      return this.user != null;
    } as Request["isAuthenticated"];
    next();
  });

  app.use("/api", router);
  return app;
}

/**
 * Generate a unique string suffix for test isolation.
 */
export function uid(prefix = "test"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
