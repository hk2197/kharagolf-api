# KHARAGOLF Enterprise

## Overview
KHARAGOLF Enterprise is a comprehensive SaaS platform for managing golf tournaments, leagues, clubs, and associations. It aims to streamline event management and enhance user experience through features like real-time leaderboards, mobile scoring, multi-tenancy, RBAC, and integrated payments. The platform supports various tournament formats, WHS Handicap calculations, automated processes, communication tools, e-commerce, weather integration, and AI assistance. The vision is to be the complete solution for golf event management, from club operations to large championships.

## User Preferences
I want iterative development. I want to be asked before you make any major changes.

## System Architecture

### UI/UX Decisions
The platform features a web dashboard for administration and a mobile player portal. It supports dynamic, organization-specific email branding, digital membership cards as branded SVGs (converted to PNGs), and club theming with customizable colors, fonts, logos, and favicons, all with live previews across web and mobile interfaces.

### Technical Implementations
The project is a monorepo utilizing `pnpm workspaces`, Node.js 24, and TypeScript 5.9. The API is built with Express 5, PostgreSQL with Drizzle ORM, and Zod for validation. API codegen uses Orval from an OpenAPI spec, and esbuild handles the build process. Authentication employs Replit Auth (OIDC with PKCE) for administrators and custom email/password for players, with Nodemailer for email services. Real-time features are powered by Server-Sent Events (SSE) and PostgreSQL. WHS Handicap calculations are WHS 2024 compliant. Full internationalization (i18n) for English, Hindi, and Arabic is supported via `i18next` and `react-i18next`, including RTL support and per-user/per-organization language preferences. Social sign-in via Google and Apple is integrated, allowing users to link and manage accounts.

### Feature Specifications
The platform offers multi-tenancy, RBAC, and comprehensive multi-round tournament management with various scoring formats, automated cut lines, and configurable side games. Player features include a player portal, real-time leaderboards, WHS Handicap Engine integration, player check-in, printable scorecards, and live hole-by-hole mobile scoring. Communication tools include invitation systems, broadcast messaging, and live announcements. Financial and commerce capabilities include a club shop, integrated payments (Stripe, Razorpay), inventory management with multi-location stock tracking, a POS system, and GST-compliant tax invoices. Analytics provide admin dashboards with KPIs and custom reporting. Advanced features include pocket foldable scorecards, prize payout calculators, round replay maps, and club distance profiling. Data retention policies include a 30-day grace period for account deletion requests, followed by hard purging of personal data and anonymization of constrained information, with detailed audit logs.

### System Design Choices
The architecture is a monorepo separating a React frontend (`artifacts/kharagolf-web`) and an Express backend (`artifacts/api-server`). The OpenAPI specification serves as the single source of truth for API definitions. Database schema migrations for development and production are automated and include drift checks for consistency.

## Operational Runbooks

### Data Retention Windows
The following append-only audit/log tables are pruned by the in-process daily cron in `artifacts/api-server/src/lib/cron.ts`. Each window is the default and is overridable via the listed env var.

- `notification_audit_log` — 365 days (env: `NOTIFICATION_AUDIT_LOG_RETENTION_DAYS`). Prune helper: `pruneNotificationAuditLog` in `artifacts/api-server/src/lib/notifyDispatch.ts`. Window matches the hard cap on the `/api/portal/notification-audit` endpoint so the portal can never query rows that have already been deleted; also caps how long personal data inside `payload` JSON outlives the erasure pipeline.
- `ops_alert_settings_history` — 365 days (env: `OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS`). Prune helper: `pruneOpsAlertSettingsHistory` in `artifacts/api-server/src/lib/opsAlertSettings.ts`.

## External Dependencies
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **API Codegen**: Orval
- **Authentication**: Replit Auth, Google Identity Services, Apple Sign-In
- **Email**: Nodemailer
- **Payments**: Stripe, Razorpay
- **Real-time**: Server-Sent Events (SSE)
- **Course Data**: GolfCourseAPI.com
- **Weather Data**: OpenWeatherMap, Open-Meteo
- **AI**: OpenAI
- **Handicap System**: GHIN API
- **Shipping**: Shiprocket
- **Internationalization**: i18next, react-i18next