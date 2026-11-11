// Server bootstrap: load config, open the database pool, start listening.
// Everything else lives in app.ts so it can be tested without opening a port.
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createAuth, createTokenVerifier } from "./middleware/auth.js";
import { createSessionCookies } from "./session/cookies.js";
import { createAuthService } from "./services/authService.js";
import { createProfileRepository } from "./repositories/profileRepository.js";
import { createProfileService } from "./services/profileService.js";

// Throws at startup if configuration is missing or invalid, so the server never runs half-configured.
const env = loadEnv();
// DATABASE_URL must be the app_user (least-privilege) connection, not the admin one.
const pool = createPool(env.DATABASE_URL);
const profiles = createProfileRepository(pool);
// Secure cookies (HTTPS only) in production; plain http://localhost cannot carry them in development.
const sessionCookies = createSessionCookies(env.NODE_ENV === "production");
const app = createApp({
    corsOrigin: env.CORS_ORIGIN,
    sessionCookies,
    authService: createAuthService({
        supabaseUrl: env.SUPABASE_URL,
        publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    }),
    auth: createAuth({
        cookies: sessionCookies,
        verifyToken: createTokenVerifier(env.SUPABASE_URL),
        profileExists: profiles.exists,
    }),
    profileService: createProfileService(profiles),
});

const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
});

// Let in-flight requests finish and release database connections on shutdown.
// server.close() stops accepting new connections and calls back once existing ones end.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close(() => {
            void pool.end().then(() => process.exit(0));
        });
    });
}
