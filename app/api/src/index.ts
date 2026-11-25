// Server bootstrap: load config, open the database pool, start listening.
// Everything else lives in app.ts so it can be tested without opening a port.
import { createApp } from "./app.js";
import { createAnalyticsRepository } from "./repositories/analyticsRepository.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createAuth, createTokenVerifier } from "./middleware/auth.js";
import { createSendMonthlySummaryJob } from "./jobs/sendMonthlySummary.js";
import { createSendRemindersJob } from "./jobs/sendReminders.js";
import { createTransitionOverdueJob } from "./jobs/transitionOverdue.js";
import { createSessionCookies } from "./session/cookies.js";
import { createAuthService } from "./services/authService.js";
import { createRateLimiters } from "./middleware/rateLimit.js";
import { reserveEmailSlot } from "./repositories/notificationLogRepository.js";
import { createPaymentMethodRepository } from "./repositories/paymentMethodRepository.js";
import { createProfileRepository } from "./repositories/profileRepository.js";
import { createSubscriptionRepository } from "./repositories/subscriptionRepository.js";
import { createEmailService } from "./services/emailService.js";
import { createNotificationService } from "./services/notificationService.js";
import { createPaymentMethodService } from "./services/paymentMethodService.js";
import { createSubscriptionService } from "./services/subscriptionService.js";
import { createProfileService } from "./services/profileService.js";
import { withUserContext } from "./db/pool.js";
import { EMAIL_DAILY_CAP } from "./services/notificationService.js";

// Throws at startup if configuration is missing or invalid, so the server never runs half-configured.
const env = loadEnv();
// DATABASE_URL must be the app_user (least-privilege) connection, not the admin one.
const pool = createPool(env.DATABASE_URL);
// The scheduled jobs use their own role and a small pool of their own, so a job can never take
// connections that user requests need.
const jobPool = createPool(env.JOB_DATABASE_URL, { max: 2 });
const profiles = createProfileRepository(pool);
const notifications = createNotificationService({
    profiles,
    email: createEmailService({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
    reserveSlot: (userId) => withUserContext(pool, userId, (client) => reserveEmailSlot(client, userId, EMAIL_DAILY_CAP)),
});
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
    paymentMethodService: createPaymentMethodService(createPaymentMethodRepository(pool)),
    subscriptionService: createSubscriptionService({
        subscriptions: createSubscriptionRepository(pool),
        notifications,
    }),
    analytics: createAnalyticsRepository(pool),
    limiters: createRateLimiters(),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    internalJobs: {
        secret: env.INTERNAL_JOB_SECRET,
        sendReminders: createSendRemindersJob({ pool: jobPool, notifications }),
        transitionOverdue: createTransitionOverdueJob({ pool: jobPool }),
        sendMonthlySummary: createSendMonthlySummaryJob({ pool: jobPool, notifications, appUrl: env.CORS_ORIGIN, linkSecret: env.EMAIL_LINK_SECRET }),
    },
    emailLinkSecret: env.EMAIL_LINK_SECRET,
});

const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
});

// Let in-flight requests finish and release database connections on shutdown.
// server.close() stops accepting new connections and calls back once existing ones end.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        server.close(() => {
            void Promise.all([pool.end(), jobPool.end()]).then(() => process.exit(0));
        });
    });
}
