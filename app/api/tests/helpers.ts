// Shared setup for the security tests: a real Express app wired with fake Supabase calls and
// tokens signed by a throwaway key, so no network, database or real account is needed.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { vi } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { createAuth, createTokenVerifier } from "../src/middleware/auth.js";
import type { AuthService } from "../src/services/authService.js";
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

interface BuildOptions {
    keys: TestKeys;
    production?: boolean;
    authService?: Partial<AuthService>;
    profileExists?: (userId: string) => Promise<boolean>;
}

// The real app, real auth middleware and real token verifier; only the outside world is faked.
export function buildTestApp({ keys, production = false, authService, profileExists }: BuildOptions) {
    const cookies = createSessionCookies(production);
    const service = createFakeAuthService(authService);
    const getProfile = vi.fn(async (id: string) => ({ id, email: "me@example.com", createdAt: new Date("2026-01-01T00:00:00.000Z") }));
    const app = createApp({
        corsOrigin: ORIGIN,
        sessionCookies: cookies,
        authService: service,
        profileService: { getProfile },
        auth: createAuth({
            cookies,
            verifyToken: createTokenVerifier(SUPABASE_URL, keys.jwks),
            profileExists: profileExists ?? (async () => true),
        }),
    });
    return { app, service, getProfile, cookies };
}
