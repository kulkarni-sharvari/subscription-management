import cors from "cors";
import express, { type RequestHandler } from "express";
import helmet from "helmet";
import { NotFoundError } from "./errors.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createMeRouter } from "./routes/me.js";
import type { ProfileService } from "./services/profileService.js";

export interface AppDeps {
    corsOrigin: string;
    // Authenticates every /api/v1 request (middleware/auth.ts).
    auth: RequestHandler;
    profileService: ProfileService;
}

// Builds the Express app without starting it, so tests can drive it through supertest
export function createApp({ corsOrigin, auth, profileService }: AppDeps) {
    const app = express();

    // should be disabled because it facilitates information disclosure, allowing attackers to easily identify the specific framework (e.g., Express, PHP, ASP.NET) and often the version of your server software.  This disclosure significantly reduces the effort required for reconnaissance and fingerprinting
    app.disable("x-powered-by");
    // Security response headers (nosniff, frame protections, HSTS, and so on).
    app.use(helmet());
    // Browser calls are allowed from the React app's exact origin only (CORS_ORIGIN), never "*".
    app.use(cors({ origin: corsOrigin }));
    // Bodies are small JSON; the cap rejects oversized payloads (413) before any parsing work.
    app.use(express.json({ limit: "100kb" }));

    // Unauthenticated liveness check; returns nothing about the system.
    app.get("/health", (_req, res) => {
        res.json({ status: "OK" });
    });

    // Everything under /api/v1 requires a valid token, so a route added here cannot forget auth.
    // Routes are mounted on `api` as each story adds them. (/internal/jobs will use its own secret
    // check and sit outside this router.)
    const api = express.Router();
    api.use(auth);
    api.use("/me", createMeRouter(profileService));
    app.use("/api/v1", api);

    // Anything that matched no route above becomes a 404 in the standard error envelope.
    app.use((_req, _res, next) => next(new NotFoundError()));
    // Must be registered last: it is the only place an error becomes an HTTP response.
    app.use(errorHandler);
    return app;
}
