import express, { type Express, type Request } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

// Task #626 — Trust the deployment's reverse proxy chain so `req.ip` is
// the real client address (used by per-IP abuse-protection limiters in
// `lib/publicRateLimit`). The API runs behind a known proxy (Replit's
// edge / load balancer); without this, `req.ip` would always be the
// proxy's loopback address and per-IP throttles would be useless. We
// never parse `X-Forwarded-For` ourselves, so this single setting is
// the only knob that controls trust.
app.set("trust proxy", true);


app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// express.json() with verify captures raw request bytes so webhook routes
// (Garmin, Razorpay) can HMAC-verify against the exact bytes that were signed.
app.use(
  express.json({
    verify: (req: Request, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Load auth session on every request
app.use(authMiddleware);

app.use("/api", router);

export default app;
