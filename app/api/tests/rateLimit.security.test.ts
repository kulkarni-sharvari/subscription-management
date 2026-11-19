// Rate limiting (SEC-025, SEC-051): who is counted, what happens at the limit, and what cannot dodge it.
import supertest from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, createTestKeys, GOOD_PASSWORD, NO_LIMITS, ORIGIN, signToken, OTHER_USER_ID, USER_ID, type TestKeys } from "./helpers.js";

let keys: TestKeys;
beforeAll(async () => {
    keys = await createTestKeys();
});

const window = (limit: number) => ({ limit, windowMs: 60_000 });
const cookieFor = async (userId: string) => `sm_access=${await signToken(keys.privateKey, { sub: userId })}`;

describe("SEC-051: per-user limit on signed-in requests", () => {
    it("answers 429 in the standard envelope once the limit is used, with Retry-After", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, perUser: window(3) } });
        const cookie = await cookieFor(USER_ID);
        for (let i = 0; i < 3; i++) expect((await supertest(app).get("/api/v1/me").set("Cookie", cookie)).status).toBe(200);

        const res = await supertest(app).get("/api/v1/me").set("Cookie", cookie);
        expect(res.status).toBe(429);
        expect(res.body).toEqual({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again later" } });
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("counts each user separately: one user at the limit does not block another", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, perUser: window(2) } });
        const [a, b] = [await cookieFor(USER_ID), await cookieFor(OTHER_USER_ID)];
        for (let i = 0; i < 3; i++) await supertest(app).get("/api/v1/me").set("Cookie", a);
        expect((await supertest(app).get("/api/v1/me").set("Cookie", a)).status).toBe(429);
        expect((await supertest(app).get("/api/v1/me").set("Cookie", b)).status).toBe(200);
    });

    it("requests without a valid session are refused before they use anyone's allowance", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, perUser: window(2) } });
        for (let i = 0; i < 5; i++) expect((await supertest(app).get("/api/v1/me")).status).toBe(401);
        expect((await supertest(app).get("/api/v1/me").set("Cookie", await cookieFor(USER_ID))).status).toBe(200);
    });
});

describe("SEC-051: the write limit on creating things", () => {
    it("stops creating after the limit while reading still works", async () => {
        const { app, paymentMethodService } = buildTestApp({ keys, limits: { ...NO_LIMITS, writes: window(2) } });
        const cookie = await cookieFor(USER_ID);
        const create = () => supertest(app).post("/api/v1/payment-methods").set("Origin", ORIGIN).set("Cookie", cookie).send({ type: "credit_card" });
        expect((await create()).status).toBe(201);
        expect((await create()).status).toBe(201);
        const blocked = await create();
        expect(blocked.status).toBe(429);
        expect(paymentMethodService.create).toHaveBeenCalledTimes(2); // the blocked request never reached the service
        expect((await supertest(app).get("/api/v1/payment-methods").set("Cookie", cookie)).status).toBe(200);
    });

    it("the same limit covers creating subscriptions", async () => {
        const { app, subscriptionService } = buildTestApp({ keys, limits: { ...NO_LIMITS, writes: window(1) } });
        const cookie = await cookieFor(USER_ID);
        const send = () => supertest(app).post("/api/v1/subscriptions").set("Origin", ORIGIN).set("Cookie", cookie).send({});
        await send();
        expect((await send()).status).toBe(429);
        expect(subscriptionService.create).not.toHaveBeenCalled(); // both were rejected as invalid (400) before the service
    });
});

describe("SEC-025: per-address limits on the sign-in endpoints", () => {
    const login = (app: Parameters<typeof supertest>[0], email: string, extra: Record<string, string> = {}) =>
        supertest(app).post("/api/v1/auth/login").set("Origin", ORIGIN).set(extra).send({ email, password: "wrong-password-123" });

    it("blocks repeated failed logins from one address, whichever emails it tries", async () => {
        const { app, service } = buildTestApp({ keys, limits: { ...NO_LIMITS, login: window(3) } });
        for (const email of ["a@example.com", "b@example.com", "c@example.com"]) expect((await login(app, email)).status).toBe(401);
        const blocked = await login(app, "d@example.com");
        expect(blocked.status).toBe(429);
        expect(service.login).toHaveBeenCalledTimes(3); // the fourth attempt never reached Supabase
    });

    it("a forged X-Forwarded-For header does not dodge the limit when no proxy is trusted", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, login: window(2) } });
        await login(app, "a@example.com", { "X-Forwarded-For": "1.1.1.1" });
        await login(app, "a@example.com", { "X-Forwarded-For": "2.2.2.2" });
        expect((await login(app, "a@example.com", { "X-Forwarded-For": "3.3.3.3" })).status).toBe(429);
    });

    it("limits registration (it sends an email, and email has a daily cap)", async () => {
        const { app, service } = buildTestApp({ keys, limits: { ...NO_LIMITS, register: window(2) } });
        const register = (n: number) =>
            supertest(app).post("/api/v1/auth/register").set("Origin", ORIGIN).send({ email: `u${n}@example.com`, password: GOOD_PASSWORD });
        expect((await register(1)).status).toBe(202);
        expect((await register(2)).status).toBe(202);
        expect((await register(3)).status).toBe(429);
        expect(service.register).toHaveBeenCalledTimes(2);
    });

    it("limits refresh and confirmation attempts", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, session: window(2) } });
        const refresh = () => supertest(app).post("/api/v1/auth/refresh").set("Origin", ORIGIN);
        await refresh();
        await refresh();
        expect((await refresh()).status).toBe(429);
        expect((await supertest(app).post("/api/v1/auth/confirm").set("Origin", ORIGIN).send({ tokenHash: "x" })).status).toBe(429);
    });

    it("logout is never limited, so a user can always end a session", async () => {
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, session: window(1), login: window(1) } });
        for (let i = 0; i < 5; i++) expect((await supertest(app).post("/api/v1/auth/logout").set("Origin", ORIGIN)).status).toBe(204);
    });
});
