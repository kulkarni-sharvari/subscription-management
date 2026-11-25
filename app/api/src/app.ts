import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet from "helmet";
import { NotFoundError } from "./errors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { RateLimiters } from "./middleware/rateLimit.js";
import { requestId } from "./middleware/requestId.js";
import { requireSameOrigin } from "./middleware/sameOrigin.js";
import { createAuthRouter } from "./routes/auth.js";
import { createInternalJobsRouter } from "./routes/internalJobs.js";
import { createMeRouter } from "./routes/me.js";
import { createPaymentMethodsRouter } from "./routes/paymentMethods.js";
import { createSubscriptionsRouter } from "./routes/subscriptions.js";
import type { SendRemindersJob } from "./jobs/sendReminders.js";
import type { TransitionOverdueJob } from "./jobs/transitionOverdue.js";
import type { AuthService } from "./services/authService.js";
import type { PaymentMethodService } from "./services/paymentMethodService.js";
import type { ProfileService } from "./services/profileService.js";
import type { SubscriptionService } from "./services/subscriptionService.js";
import type { AnalyticsRepository } from "./repositories/analyticsRepository.js";
import { createAnalyticsRouter } from "./routes/analytics.js";
import type { SessionCookies } from "./session/cookies.js";

export interface AppDeps {
    corsOrigin: string;
    // Authenticates every /api/v1 request except /auth (middleware/auth.ts).
    auth: RequestHandler;
    authService: AuthService;
    sessionCookies: SessionCookies;
    profileService: ProfileService;
    paymentMethodService: PaymentMethodService;
    subscriptionService: SubscriptionService;
    // Story 9: read-only spending analytics.
    analytics: Pick<AnalyticsRepository, "spending">;
    limiters: RateLimiters;
    // Reverse proxies in front of the API (0 = none); decides which address counts as the client.
    trustProxyHops: number;
    // The scheduled jobs and the shared secret that guards them (routes/internalJobs.ts).
    internalJobs: { secret: string; sendReminders: Pick<SendRemindersJob, "run">; transitionOverdue: Pick<TransitionOverdueJob, "run"> };
}

// Builds the Express app without starting it, so tests can drive it through supertest
export function createApp({
    corsOrigin,
    auth,
    authService,
    sessionCookies,
    profileService,
    paymentMethodService,
    subscriptionService,
    analytics,
    limiters,
    trustProxyHops,
    internalJobs,
}: AppDeps) {
    const app = express();
    // Rate limits are counted per client address. Behind a reverse proxy every request seems to come
    // from the proxy unless Express is told how many hops to skip; too high a number would let a
    // client choose its own address with a forged header, so it is set exactly, from configuration.
    app.set("trust proxy", trustProxyHops);

    // should be disabled because it facilitates information disclosure, allowing attackers to easily identify the specific framework (e.g., Express, PHP, ASP.NET) and often the version of your server software.  This disclosure significantly reduces the effort required for reconnaissance and fingerprinting
    app.disable("x-powered-by");
    // Security response headers (nosniff, frame protections, HSTS, and so on).
    app.use(helmet());
    // Browser calls are allowed from the React app's exact origin only (CORS_ORIGIN), never "*".
    // credentials: the session cookie may be sent, which is only allowed with an exact origin.
    app.use(cors({ origin: corsOrigin, credentials: true }));
    app.use(cookieParser());
    app.use(requestId);
    // Bodies are small JSON; the cap rejects oversized payloads (413) before any parsing work.
    app.use(express.json({ limit: "100kb" }));

    // Unauthenticated liveness check; returns nothing about the system.
    app.get("/health", (_req, res) => {
        res.json({ status: "OK" });
    });

    // Responses hold personal data and session cookies: browsers and proxies must not cache them.
    app.use("/api", (_req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });

    // Everything under /api/v1 below `auth` requires a valid token, so a route added there cannot
    // forget auth. Only /auth, which signs people in, is mounted above it. (/internal/jobs will use
    // its own secret check and sit outside this router.)
    const api = express.Router();
    // CSRF check for every state-changing request, before anything else runs.
    api.use(requireSameOrigin(corsOrigin));
    api.use("/auth", createAuthRouter(authService, sessionCookies, limiters));
    api.use(auth);
    // Counted per user, so it can only sit below the auth middleware.
    api.use(limiters.perUser);
    api.use("/me", createMeRouter(profileService, limiters));
    api.use("/payment-methods", createPaymentMethodsRouter(paymentMethodService, limiters));
    api.use("/subscriptions", createSubscriptionsRouter(subscriptionService, limiters));
    api.use("/analytics", createAnalyticsRouter(analytics, limiters));
    // The job routes sit before the user router and outside it: no cookie, no CSRF check, only the secret.
    app.use("/api/v1/internal/jobs", createInternalJobsRouter({ ...internalJobs, limiters }));
    app.use("/api/v1", api);

    // Anything that matched no route above becomes a 404 in the standard error envelope.
    app.use((_req, _res, next) => next(new NotFoundError()));
    // Must be registered last: it is the only place an error becomes an HTTP response.
    app.use(errorHandler);
    return app;
}
