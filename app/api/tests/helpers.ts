// Shared setup for the security tests: a real Express app wired with fake Supabase calls and
// tokens signed by a throwaway key, so no network, database or real account is needed.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { createAnalyticsRepository } from "../src/repositories/analyticsRepository.js";
import { vi } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { createAuth, createTokenVerifier } from "../src/middleware/auth.js";
import { createRateLimiters, type RateLimitConfig } from "../src/middleware/rateLimit.js";
import { createPaymentMethodRepository } from "../src/repositories/paymentMethodRepository.js";
import { createProfileRepository } from "../src/repositories/profileRepository.js";
import { createSubscriptionRepository } from "../src/repositories/subscriptionRepository.js";
import type { AuthService } from "../src/services/authService.js";
import { createNotificationService, EMAIL_DAILY_CAP } from "../src/services/notificationService.js";
import { withUserContext } from "../src/db/pool.js";
import { createSendMonthlySummaryJob } from "../src/jobs/sendMonthlySummary.js";
import { createSendRemindersJob } from "../src/jobs/sendReminders.js";
import { createTransitionOverdueJob } from "../src/jobs/transitionOverdue.js";
import { reserveEmailSlot } from "../src/repositories/notificationLogRepository.js";
import { createPaymentMethodService } from "../src/services/paymentMethodService.js";
import { createProfileService } from "../src/services/profileService.js";
import { createSubscriptionService } from "../src/services/subscriptionService.js";
import type { EmailMessage } from "../src/services/emailService.js";
import type { Db } from "./dbHelpers.js";
import { createSessionCookies } from "../src/session/cookies.js";

export const ORIGIN = "http://localhost:3000";
export const SUPABASE_URL = "https://testref.supabase.co";
export const ISSUER = `${SUPABASE_URL}/auth/v1`;
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
export const GOOD_PASSWORD = "correct-horse-battery-1";

export interface TestKeys {
    privateKey: CryptoKey;
    jwks: JWTVerifyGetKey;
    publicJwk: Record<string, unknown>;
}

// A fresh ES256 key pair, the algorithm the Supabase project signs with.
export async function createTestKeys(): Promise<TestKeys> {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
    return { privateKey, jwks: createLocalJWKSet({ keys: [publicJwk] }), publicJwk };
}

interface TokenOptions {
    sub?: string;
    iss?: string;
    aud?: string;
    expiresIn?: string | number;
}

// Signs an access token that looks like Supabase's. Pass options to make it wrong in one way.
export async function signToken(privateKey: CryptoKey, options: TokenOptions = {}): Promise<string> {
    return new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "test-key" })
        .setSubject(options.sub ?? USER_ID)
        .setIssuer(options.iss ?? ISSUER)
        .setAudience(options.aud ?? "authenticated")
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "1h")
        .sign(privateKey);
}

export const session = { accessToken: "ACCESS-TOKEN", refreshToken: "REFRESH-TOKEN", expiresIn: 3600 };

// Every method is a spy, so tests can assert what was (and was not) called.
export function createFakeAuthService(overrides: Partial<AuthService> = {}) {
    const service = {
        register: vi.fn(async () => {}),
        login: vi.fn(async (_email: string, password: string) => {
            if (password !== GOOD_PASSWORD) {
                throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
            }
            return session;
        }),
        confirmEmail: vi.fn(async () => session),
        refresh: vi.fn(async () => ({ ...session, accessToken: "ACCESS-TOKEN-2" })),
        logout: vi.fn(async () => {}),
        ...overrides,
    };
    return service satisfies AuthService;
}

const unlimited = { limit: 1_000_000, windowMs: 60_000 };
// Limits so high that tests never meet them by accident; rate-limit tests pass their own.
export const NO_LIMITS: RateLimitConfig = {
    perUser: unlimited, writes: unlimited, login: unlimited, register: unlimited, session: unlimited, jobAuthFailures: unlimited, analytics: unlimited, emailLinks: unlimited,
};

// A job secret for tests: 43 characters, like 32 random bytes in base64url.
export const JOB_SECRET = "test-job-secret-0123456789abcdefghijklmnopq";
// Signs unsubscribe links in tests (Story 10).
export const EMAIL_LINK_SECRET = "test-email-link-secret-0123456789abcdefghij";

interface BuildOptions {
    keys: TestKeys;
    production?: boolean;
    authService?: Partial<AuthService>;
    profileExists?: (userId: string) => Promise<boolean>;
    limits?: RateLimitConfig;
}

// The real app, real auth middleware and real token verifier; only the outside world is faked.
export function buildTestApp({ keys, production = false, authService, profileExists, limits = NO_LIMITS }: BuildOptions) {
    const cookies = createSessionCookies(production);
    const service = createFakeAuthService(authService);
    const getProfile = vi.fn(async (id: string) => ({ id, email: "me@example.com", timeZone: "UTC", createdAt: new Date("2026-01-01T00:00:00.000Z") }));
    const updateProfile = vi.fn(async (id: string, settings: { timeZone?: string; monthlySummary?: boolean }) => ({
        id, email: "me@example.com", timeZone: settings.timeZone ?? "UTC", monthlySummary: settings.monthlySummary ?? true, createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    const sendMonthlySummary = { run: vi.fn(async () => ({ usersDue: 0, sent: 0, alreadySent: 0, nothingToReport: 0, capped: 0, failed: 0 })) };
    const sendReminders = { run: vi.fn(async () => ({ usersDue: 0, sent: 0, alreadySent: 0, notYetMorning: 0, capped: 0, failed: 0 })) };
    const transitionOverdue = { run: vi.fn(async () => ({ usersLapsed: 0, subscriptionsLapsed: 0, failed: 0 })) };
    const paymentMethodService = {
        create: vi.fn(async () => ({ id: USER_ID, type: "credit_card" as const, isActive: true, createdAt: new Date() })),
        list: vi.fn(async () => []),
    };
    const subscriptionService = {
        create: vi.fn(async () => ({}) as never),
        list: vi.fn(async () => ({ items: [], nextCursor: null })),
        get: vi.fn(async () => ({}) as never),
        renew: vi.fn(async () => ({}) as never),
        cancel: vi.fn(async () => ({}) as never),
        update: vi.fn(async () => ({}) as never),
    };
    const app = createApp({
        corsOrigin: ORIGIN,
        sessionCookies: cookies,
        authService: service,
        profileService: { getProfile, update: updateProfile },
        paymentMethodService,
        subscriptionService,
        analytics: { spending: vi.fn(async () => ({}) as never) },
        limiters: createRateLimiters(limits),
        trustProxyHops: 0,
        internalJobs: { secret: JOB_SECRET, sendReminders, transitionOverdue, sendMonthlySummary },
        emailLinkSecret: EMAIL_LINK_SECRET,
        auth: createAuth({
            cookies,
            verifyToken: createTokenVerifier(SUPABASE_URL, keys.jwks),
            profileExists: profileExists ?? (async () => true),
        }),
    });
    return { app, service, getProfile, updateProfile, sendReminders, transitionOverdue, sendMonthlySummary, cookies, paymentMethodService, subscriptionService };
}

// The same app, but with the real repositories and services on the local database. Only the
// email provider is replaced by a spy, so tests can see what would be sent and to whom.
export function buildDbTestApp({
    keys,
    db,
    limits = NO_LIMITS,
    sendEmail,
    now,
}: {
    keys: TestKeys;
    db: Db;
    limits?: RateLimitConfig;
    sendEmail?: (m: EmailMessage) => Promise<void>;
    now?: () => Date;
}) {
    const cookies = createSessionCookies(false);
    const profiles = createProfileRepository(db.app);
    const email = vi.fn(sendEmail ?? (async () => {}));
    const notifications = createNotificationService({
        profiles,
        email: { send: email },
        reserveSlot: (userId) => withUserContext(db.app, userId, (client) => reserveEmailSlot(client, userId, EMAIL_DAILY_CAP)),
    });
    const app = createApp({
        corsOrigin: ORIGIN,
        sessionCookies: cookies,
        authService: createFakeAuthService(),
        profileService: createProfileService(profiles),
        paymentMethodService: createPaymentMethodService(createPaymentMethodRepository(db.app)),
        subscriptionService: createSubscriptionService({
            subscriptions: createSubscriptionRepository(db.app),
            notifications,
        }),
        analytics: createAnalyticsRepository(db.app),
        limiters: createRateLimiters(limits),
        trustProxyHops: 0,
        internalJobs: {
            secret: JOB_SECRET,
            sendReminders: createSendRemindersJob({ pool: db.job, notifications, now }),
            transitionOverdue: createTransitionOverdueJob({ pool: db.job, now }),
            sendMonthlySummary: createSendMonthlySummaryJob({ pool: db.job, notifications, appUrl: ORIGIN, linkSecret: EMAIL_LINK_SECRET, now }),
        },
        emailLinkSecret: EMAIL_LINK_SECRET,
        auth: createAuth({ cookies, verifyToken: createTokenVerifier(SUPABASE_URL, keys.jwks), profileExists: profiles.exists }),
    });
    return { app, email };
}

// A session cookie for a user id, signed by the test key.
export async function sessionCookie(keys: TestKeys, userId: string): Promise<string> {
    return `sm_access=${await signToken(keys.privateKey, { sub: userId })}`;
}
