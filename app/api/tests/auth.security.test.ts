// Story 1 security tests: authentication, sessions and error handling.
import { inspect } from "node:util";
import { SignJWT } from "jose";
import supertest from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTokenVerifier } from "../src/middleware/auth.js";
import {
    buildTestApp,
    createTestKeys,
    GOOD_PASSWORD,
    ISSUER,
    ORIGIN,
    OTHER_USER_ID,
    session,
    signToken,
    SUPABASE_URL,
    USER_ID,
    type TestKeys,
} from "./helpers.js";

let keys: TestKeys;
let otherKeys: TestKeys;

// First generate test keys.
beforeAll(async () => {
    keys = await createTestKeys();
    otherKeys = await createTestKeys();
});
// At the end of each test run, this will empty `.mock` state, restore all original mock implementations, and restore original descriptors of spied-on objects.
afterEach(() => vi.restoreAllMocks());

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cookieHeader = (token: string) => `sm_access=${token}`;
// supertest types every header as a string, but set-cookie is really a list (one entry per cookie).
const setCookies = (res: supertest.Response): string[] => (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];

describe("SEC-021: access token verification", () => {
    const verify = () => createTokenVerifier(SUPABASE_URL, keys.jwks);

    it("accepts a correctly signed token and returns its subject", async () => {
        await expect(verify()(await signToken(keys.privateKey))).resolves.toBe(USER_ID);
    });

    const rejected: Array<[string, () => Promise<string>]> = [
        ["an expired token", () => signToken(keys.privateKey, { expiresIn: Math.floor(Date.now() / 1000) - 60 })],
        ["a token signed by another key", () => signToken(otherKeys.privateKey)],
        ["a token for the wrong audience", () => signToken(keys.privateKey, { aud: "anon" })],
        ["a token from another issuer or project", () => signToken(keys.privateKey, { iss: "https://other.supabase.co/auth/v1" })],
        ["a token whose subject is not a UUID", () => signToken(keys.privateKey, { sub: "1 OR 1=1" })],
        [
            "a token with a tampered payload (signature no longer matches)",
            async () => {
                const [header, , signature] = (await signToken(keys.privateKey)).split(".");
                return `${header}.${b64url({ sub: OTHER_USER_ID, iss: ISSUER, aud: "authenticated", exp: 9999999999 })}.${signature}`;
            },
        ],
        [
            'an unsigned token with alg "none"',
            async () =>
                `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: USER_ID, iss: ISSUER, aud: "authenticated", exp: 9999999999 })}.`,
        ],
        [
            "an HS256 token signed with the public key as the secret (algorithm confusion)",
            () =>
                new SignJWT({})
                    .setProtectedHeader({ alg: "HS256" })
                    .setSubject(USER_ID)
                    .setIssuer(ISSUER)
                    .setAudience("authenticated")
                    .setExpirationTime("1h")
                    .sign(new TextEncoder().encode(JSON.stringify(keys.publicJwk))),
        ],
        ["an empty string", async () => ""],
        ["random text", async () => "not.a.jwt"],
    ];
    it.each(rejected)("rejects %s", async (_name, makeToken) => {
        await expect(verify()(await makeToken())).rejects.toThrow();
    });

    it("rejects a correctly signed token that uses a different algorithm than ES256 (the algorithm is pinned)", async () => {
        // A key set can hold more than one key type, for example while keys are being rotated.
        const { generateKeyPair, exportJWK, createLocalJWKSet } = await import("jose");
        const rsa = await generateKeyPair("RS256");
        const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: "rsa-key", alg: "RS256", use: "sig" };
        const mixedKeys = createLocalJWKSet({ keys: [keys.publicJwk as never, rsaJwk] });
        const rs256Token = await new SignJWT({})
            .setProtectedHeader({ alg: "RS256", kid: "rsa-key" })
            .setSubject(USER_ID)
            .setIssuer(ISSUER)
            .setAudience("authenticated")
            .setExpirationTime("1h")
            .sign(rsa.privateKey);
        await expect(createTokenVerifier(SUPABASE_URL, mixedKeys)(rs256Token)).rejects.toThrow();
    });

    it("never takes the user id from anywhere but the token (query, header, body are ignored)", async () => {
        const { app, getProfile } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app)
            .get(`/api/v1/me?userId=${OTHER_USER_ID}`)
            .set("Cookie", cookieHeader(token))
            .set("X-User-Id", OTHER_USER_ID);
        expect(res.status).toBe(200);
        expect(getProfile).toHaveBeenCalledWith(USER_ID);
    });
});

describe("SEC-021 / SEC-068: the auth middleware", () => {
    it("returns 401 with no cookie", async () => {
        const { app } = buildTestApp({ keys });
        const res = await supertest(app).get("/api/v1/me");
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    });

    it("ignores an Authorization: Bearer header, even a valid one (cookie sessions only)", async () => {
        const { app } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app).get("/api/v1/me").set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
    });

    it("gives the same bare 401 whatever is wrong with the token (no detail leaks)", async () => {
        const { app } = buildTestApp({ keys });
        const bodies = new Set<string>();
        for (const token of [
            await signToken(keys.privateKey, { aud: "anon" }),
            await signToken(otherKeys.privateKey),
            await signToken(keys.privateKey, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
            "garbage",
        ]) {
            const res = await supertest(app).get("/api/v1/me").set("Cookie", cookieHeader(token));
            expect(res.status).toBe(401);
            bodies.add(JSON.stringify(res.body));
        }
        expect(bodies.size).toBe(1);
    });

    it("SEC-068: a valid token for a deleted account (no profile row) returns 401 and reads nothing", async () => {
        const { app, getProfile } = buildTestApp({ keys, profileExists: async () => false });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app).get("/api/v1/me").set("Cookie", cookieHeader(token));
        expect(res.status).toBe(401);
        expect(getProfile).not.toHaveBeenCalled();
    });

    it("every /api/v1 path except /auth requires a session (unknown paths included)", async () => {
        const { app } = buildTestApp({ keys });
        for (const path of ["/api/v1/me", "/api/v1/subscriptions", "/api/v1/anything/else"]) {
            expect((await supertest(app).get(path)).status).toBe(401);
        }
    });
});

describe("SEC-022 / T-02a: the session cookies", () => {
    async function login(production: boolean) {
        const { app } = buildTestApp({ keys, production });
        return supertest(app).post("/api/v1/auth/login").set("Origin", ORIGIN).send({ email: "me@example.com", password: GOOD_PASSWORD });
    }

    it("sets httpOnly, SameSite=Strict cookies and never puts a token in the response body", async () => {
        const res = await login(false);
        expect(res.status).toBe(204);
        expect(res.text).toBe("");
        const cookies = setCookies(res);
        expect(cookies).toHaveLength(2);
        for (const cookie of cookies) {
            expect(cookie).toMatch(/; HttpOnly/);
            expect(cookie).toMatch(/; SameSite=Strict/);
        }
    });

    it("scopes the access cookie to /api and the refresh cookie to /api/v1/auth only", async () => {
        const cookies = setCookies(await login(false));
        expect(cookies.find((c) => c.startsWith("sm_access="))).toMatch(/; Path=\/api(;|$)/);
        expect(cookies.find((c) => c.startsWith("sm_refresh="))).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
    });

    it("gives the access cookie the token's lifetime and the refresh cookie at most 7 days", async () => {
        const cookies = setCookies(await login(false));
        expect(cookies.find((c) => c.startsWith("sm_access="))).toMatch(/Max-Age=3600/);
        const refreshAge = Number(/Max-Age=(\d+)/.exec(cookies.find((c) => c.startsWith("sm_refresh="))!)?.[1]);
        expect(refreshAge).toBeLessThanOrEqual(7 * 24 * 3600);
    });

    it("in production the cookies are Secure and carry the __Secure- prefix", async () => {
        const cookies = setCookies(await login(true));
        expect(cookies.every((c) => c.startsWith("__Secure-sm_") && /; Secure/.test(c))).toBe(true);
    });

    it("marks every API response no-store so tokens and profiles are never cached", async () => {
        const { app } = buildTestApp({ keys });
        for (const res of [await supertest(app).get("/api/v1/me"), await supertest(app).get("/api/v1/nothing")]) {
            expect(res.headers["cache-control"]).toBe("no-store");
        }
    });

    it("logout sends both tokens to be revoked and clears both cookies", async () => {
        const { app, service } = buildTestApp({ keys });
        const res = await supertest(app)
            .post("/api/v1/auth/logout")
            .set("Origin", ORIGIN)
            .set("Cookie", `sm_access=${session.accessToken}; sm_refresh=${session.refreshToken}`);
        expect(res.status).toBe(204);
        expect(service.logout).toHaveBeenCalledWith({ accessToken: session.accessToken, refreshToken: session.refreshToken });
        const cleared = setCookies(res);
        expect(cleared).toHaveLength(2);
        expect(cleared.every((c) => /=;/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
    });

    it("logout still clears the cookies when revoking at Supabase fails, and logs no token", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { app } = buildTestApp({ keys, authService: { logout: async () => { throw new Error("supabase down"); } } });
        const res = await supertest(app)
            .post("/api/v1/auth/logout")
            .set("Origin", ORIGIN)
            .set("Cookie", `sm_access=${session.accessToken}; sm_refresh=${session.refreshToken}`);
        expect(res.status).toBe(204);
        expect(setCookies(res)).toHaveLength(2);
        const logged = inspect(error.mock.calls, { depth: 6 });
        expect(logged).toContain("supabase down");
        expect(logged).not.toContain(session.refreshToken);
        expect(logged).not.toContain(session.accessToken);
    });

    it("logout with no session is harmless and does not call Supabase", async () => {
        const { app, service } = buildTestApp({ keys });
        const res = await supertest(app).post("/api/v1/auth/logout").set("Origin", ORIGIN);
        expect(res.status).toBe(204);
        expect(service.logout).not.toHaveBeenCalled();
    });

    it("refresh without a refresh cookie returns 401 and does not call Supabase", async () => {
        const { app, service } = buildTestApp({ keys });
        const res = await supertest(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN);
        expect(res.status).toBe(401);
        expect(service.refresh).not.toHaveBeenCalled();
    });

    it("a refresh that fails clears the cookies so a dead session is not retried", async () => {
        const { app } = buildTestApp({
            keys,
            authService: { refresh: async () => { throw new (await import("../src/errors.js")).UnauthorizedError(); } },
        });
        const res = await supertest(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN).set("Cookie", "sm_refresh=revoked");
        expect(res.status).toBe(401);
        expect(setCookies(res)).toHaveLength(2);
    });

    it("the access token is not accepted from the refresh cookie name (and vice versa)", async () => {
        const { app } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app).get("/api/v1/me").set("Cookie", `sm_refresh=${token}`);
        expect(res.status).toBe(401);
    });
});

describe("T-08 / CSRF: the Origin check on state-changing requests", () => {
    const posts = ["register", "login", "confirm", "refresh", "logout"];

    it.each(posts)("POST /auth/%s without an Origin header returns 403", async (name) => {
        const { app, service } = buildTestApp({ keys });
        const res = await supertest(app).post(`/api/v1/auth/${name}`).send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("FORBIDDEN");
        for (const spy of Object.values(service)) expect(spy).not.toHaveBeenCalled();
    });

    it.each(["https://evil.example", "http://localhost:3001", "http://localhost:3000.", "null", `${ORIGIN}/`])(
        "rejects the look-alike origin %s",
        async (origin) => {
            const { app, service } = buildTestApp({ keys });
            const res = await supertest(app)
                .post("/api/v1/auth/login")
                .set("Origin", origin)
                .send({ email: "me@example.com", password: GOOD_PASSWORD });
            expect(res.status).toBe(403);
            expect(service.login).not.toHaveBeenCalled();
        },
    );

    it("does not apply to read-only requests", async () => {
        const { app } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        expect((await supertest(app).get("/api/v1/me").set("Cookie", cookieHeader(token))).status).toBe(200);
    });
});

describe("SEC-024: sign-up and login answer the same whether or not the email is registered", () => {
    it("register returns an identical status and body for any email, and never echoes it", async () => {
        const { app } = buildTestApp({ keys });
        const send = (email: string) =>
            supertest(app).post("/api/v1/auth/register").set("Origin", ORIGIN).send({ email, password: "a-long-enough-pass-1" });
        const [a, b] = [await send("registered@example.com"), await send("brand-new@example.com")];
        expect(a.status).toBe(202);
        expect(b.status).toBe(a.status);
        expect(b.body).toEqual(a.body);
        expect(JSON.stringify(a.body)).not.toContain("example.com");
    });

    it("login gives one error for a wrong password and for an unknown account", async () => {
        const { app } = buildTestApp({ keys });
        const send = (email: string) =>
            supertest(app).post("/api/v1/auth/login").set("Origin", ORIGIN).send({ email, password: "wrong-password-123" });
        const [a, b] = [await send("registered@example.com"), await send("nobody@example.com")];
        expect(a.status).toBe(401);
        expect(b.status).toBe(a.status);
        expect(b.body).toEqual(a.body);
    });
    // The Supabase side of this (the real service) is a live check: see "Manual checks" in security-testing.md.
});

describe("input validation on the auth endpoints (SEC-033, SEC-038)", () => {
    const register = (app: Parameters<typeof supertest>[0], body: unknown) =>
        supertest(app).post("/api/v1/auth/register").set("Origin", ORIGIN).send(body as object);

    it("rejects a 13-character password and a 73-character password; accepts 14", async () => {
        const { app } = buildTestApp({ keys });
        expect((await register(app, { email: "a@example.com", password: "a".repeat(13) })).body.error.field).toBe("password");
        expect((await register(app, { email: "a@example.com", password: "a".repeat(73) })).body.error.field).toBe("password");
        expect((await register(app, { email: "a@example.com", password: "a".repeat(14) })).status).toBe(202);
    });

    it.each([
        ["SQL injection", "' OR 1=1 --"],
        ["stacked query", "a@example.com'; DROP TABLE profiles; --"],
        ["an object (operator injection)", { $ne: "" }],
        ["an array", ["a@example.com"]],
        ["a number", 12345],
        ["too long", `${"a".repeat(250)}@example.com`],
    ])("rejects %s as the email and never calls Supabase", async (_name, email) => {
        const { app, service } = buildTestApp({ keys });
        const res = await register(app, { email, password: "a-long-enough-pass-1" });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        expect(service.register).not.toHaveBeenCalled();
    });

    it("rejects a missing body, a non-object body and an oversized confirmation token", async () => {
        const { app, service } = buildTestApp({ keys });
        expect((await supertest(app).post("/api/v1/auth/login").set("Origin", ORIGIN)).status).toBe(400);
        expect((await register(app, ["x"])).status).toBe(400);
        const res = await supertest(app).post("/api/v1/auth/confirm").set("Origin", ORIGIN).send({ tokenHash: "x".repeat(600) });
        expect(res.status).toBe(400);
        expect(service.confirmEmail).not.toHaveBeenCalled();
    });

    it("normalises the email (trim, lower case) before it reaches Supabase", async () => {
        const { app, service } = buildTestApp({ keys });
        await register(app, { email: "  Me@Example.COM ", password: "a-long-enough-pass-1" });
        expect(service.register).toHaveBeenCalledWith("me@example.com", "a-long-enough-pass-1");
    });

    it("a request body over 100 kb is refused with 413 before any handler runs", async () => {
        const { app, service } = buildTestApp({ keys });
        const res = await register(app, { email: "a@example.com", password: "x".repeat(200_000) });
        expect(res.status).toBe(413);
        expect(service.register).not.toHaveBeenCalled();
    });
});

describe("SEC-039: errors never expose internals", () => {
    const SECRET_DETAIL = "SELECT secret_column FROM auth.users WHERE id = 42 at /srv/app/db.ts:10";

    it("an unexpected failure returns the generic 500 with no message, stack or SQL", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { app } = buildTestApp({ keys, authService: { register: async () => { throw new Error(SECRET_DETAIL); } } });
        const res = await supertest(app)
            .post("/api/v1/auth/register")
            .set("Origin", ORIGIN)
            .send({ email: "a@example.com", password: "a-long-enough-pass-1" });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
        expect(res.text).not.toMatch(/SELECT|auth\.users|\.ts:|stack|node_modules/i);
    });

    it("malformed JSON returns a clean 400", async () => {
        const { app } = buildTestApp({ keys });
        const res = await supertest(app)
            .post("/api/v1/auth/login")
            .set("Origin", ORIGIN)
            .set("Content-Type", "application/json")
            .send('{"email": ');
        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(/SyntaxError|at JSON|node_modules/);
    });

    it("an unknown path returns the standard 401/404 envelope, never an HTML error page", async () => {
        const { app } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app).get("/nope").set("Cookie", cookieHeader(token));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("hides the framework: no X-Powered-By, and helmet's security headers are present", async () => {
        const { app } = buildTestApp({ keys });
        const res = await supertest(app).get("/health");
        expect(res.headers["x-powered-by"]).toBeUndefined();
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["strict-transport-security"]).toBeDefined();
    });
});

describe("SEC-019: logs never contain passwords, tokens or cookies", () => {
    it("a failing request logs the method, path and error but not the body or the cookies", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { app } = buildTestApp({ keys, authService: { login: async () => { throw new Error("upstream failure"); } } });
        const token = await signToken(keys.privateKey);
        const password = "Sup3r-Secret-Passw0rd!";
        await supertest(app)
            .post("/api/v1/auth/login")
            .set("Origin", ORIGIN)
            .set("Cookie", `sm_access=${token}; sm_refresh=${session.refreshToken}`)
            .set("Authorization", `Bearer ${token}`)
            .send({ email: "me@example.com", password });

        // inspect (not JSON.stringify) so the text inside Error objects is included, as in a real log.
        const logged = inspect([error.mock.calls, log.mock.calls, warn.mock.calls], { depth: 6 });
        expect(logged).toContain("upstream failure");
        for (const secret of [password, token, session.refreshToken, "me@example.com"]) {
            expect(logged).not.toContain(secret);
        }
    });
});
