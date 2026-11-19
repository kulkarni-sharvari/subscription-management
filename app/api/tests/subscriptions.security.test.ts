// Story 2 API security tests: the real routes, services and repositories against a throwaway local
// PostgreSQL. Only the email provider is a spy. Names start with the requirement they verify.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createSubscriptionRepository } from "../src/repositories/subscriptionRepository.js";
import { connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, createTestKeys, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");

describe.skipIf(!local)("Story 2: payment methods and subscriptions through the API", () => {
    let db: Db;
    let keys: TestKeys;
    let api: ReturnType<typeof supertest>;
    let email: ReturnType<typeof buildDbTestApp>["email"];
    let alice: { id: string; email: string; cookie: string };
    let bob: { id: string; email: string; cookie: string };

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        const built = buildDbTestApp({ keys, db });
        api = supertest(built.app);
        email = built.email;
        for (const [name, slot] of [["alice", "a"], ["bob", "b"]] as const) {
            const user = await createUser(db, `${name}@example.com`);
            const person = { ...user, cookie: await sessionCookie(keys, user.id) };
            if (slot === "a") alice = person;
            else bob = person;
        }
    });
    afterAll(() => db.close());

    // The body is sent as raw JSON text, so values that are not objects (5, "text", null) can be tried too.
    const post = (path: string, who: { cookie: string }, body: unknown) =>
        api.post(`/api/v1${path}`).set("Origin", ORIGIN).set("Cookie", who.cookie).set("Content-Type", "application/json").send(JSON.stringify(body));
    const get = (path: string, who: { cookie: string }) => api.get(`/api/v1${path}`).set("Cookie", who.cookie);
    const rows = async (table: string, userId: string) =>
        Number((await db.admin.query(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1`, [userId])).rows[0].n);

    const newMethod = async (who: { cookie: string }, type = "credit_card") => (await post("/payment-methods", who, { type })).body.id as string;
    const body = (paymentMethodId: string, overrides: Record<string, unknown> = {}) => ({
        name: "Netflix",
        category: "Entertainment",
        subscriptionType: "recurring",
        billingPeriod: "monthly",
        startDate: "2026-09-08",
        cost: 15.49,
        paymentMethodId,
        renewalLink: "https://example.com/renew",
        cancellationLink: "https://example.com/cancel",
        autoRenews: true,
        ...overrides,
    });

    describe("SEC-021: every endpoint needs a session", () => {
        it.each([
            ["get", "/payment-methods"], ["post", "/payment-methods"],
            ["get", "/subscriptions?status=active"], ["post", "/subscriptions"],
        ] as const)("%s %s without a cookie returns 401", async (method, path) => {
            const res = await api[method](`/api/v1${path}`).set("Origin", ORIGIN).send({});
            expect(res.status).toBe(401);
        });
    });

    describe("payment methods (FR-041, FR-043)", () => {
        it("creates one and returns the documented shape, with no user id", async () => {
            const res = await post("/payment-methods", alice, { type: "apple_pay" });
            expect(res.status).toBe(201);
            expect(Object.keys(res.body).sort()).toEqual(["createdAt", "id", "isActive", "type"]);
            expect(res.body).toMatchObject({ type: "apple_pay", isActive: true });
        });

        it.each([{}, { type: "bitcoin" }, { type: 5 }, { type: "credit_card", userId: "x" }, { type: "credit_card", isActive: false }, "credit_card", null])(
            "rejects the body %j with 400 and creates nothing (SEC-030)",
            async (payload) => {
                const before = await rows("payment_methods", alice.id);
                const res = await post("/payment-methods", alice, payload);
                expect(res.status).toBe(400);
                expect(res.body.error.code).toBe("VALIDATION_ERROR");
                expect(await rows("payment_methods", alice.id)).toBe(before);
            },
        );

        it("SEC-029: a user lists only their own payment methods", async () => {
            const bobMethod = await newMethod(bob, "debit_card");
            const aliceList = (await get("/payment-methods", alice)).body as Array<{ id: string }>;
            expect(aliceList.length).toBeGreaterThan(0);
            expect(aliceList.map((m) => m.id)).not.toContain(bobMethod);
            expect((await get("/payment-methods", bob)).body.map((m: { id: string }) => m.id)).toContain(bobMethod);
        });

        it("rejects an unknown query parameter or value", async () => {
            expect((await get("/payment-methods?activeOnly=maybe", alice)).status).toBe(400);
            expect((await get("/payment-methods?user_id=x", alice)).status).toBe(400);
        });
    });

    describe("creating a subscription (FR-010 to FR-013, FR-044)", () => {
        it("FR-043: with no payment method on file the request is refused and nothing is saved", async () => {
            const carol = await createUser(db);
            const who = { ...carol, cookie: await sessionCookie(keys, carol.id) };
            const res = await post("/subscriptions", who, body("11111111-1111-4111-8111-111111111111"));
            expect(res.status).toBe(400);
            expect(res.body.error.field).toBe("paymentMethodId");
            expect(await rows("subscriptions", carol.id)).toBe(0);
        });

        it("creates an active subscription and its first billing row, and returns the documented shape", async () => {
            const pm = await newMethod(alice);
            const res = await post("/subscriptions", alice, body(pm));
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                name: "Netflix", category: "Entertainment", cost: 15.49, billingPeriod: "monthly",
                subscriptionType: "recurring", status: "active", autoRenews: true, startDate: "2026-09-08",
                paymentMethod: { id: pm, type: "credit_card" },
                currentCycle: { dueDate: "2026-10-08", status: "paid" },
                renewalLink: "https://example.com/renew", cancellationLink: "https://example.com/cancel",
            });
            expect(res.body).not.toHaveProperty("userId");
            expect(res.body).not.toHaveProperty("user_id");

            const billing = await db.admin.query("SELECT * FROM billing WHERE subscription_id = $1", [res.body.id]);
            expect(billing.rows).toHaveLength(1);
            expect(billing.rows[0]).toMatchObject({ user_id: alice.id, payment_method_id: pm, status: "paid", amount: "15.49", created_by: "user" });
            expect(billing.rows[0].due_date).toBe("2026-10-08");
        });

        it.each([
            ["monthly", "2026-01-31", "2026-02-28"],
            ["6_months", "2026-08-31", "2027-02-28"],
            ["annually", "2024-02-29", "2025-02-28"],
        ])("BR-003: %s from %s is due %s", async (billingPeriod, startDate, due) => {
            const res = await post("/subscriptions", alice, body(await newMethod(alice), { billingPeriod, startDate }));
            expect(res.status).toBe(201);
            expect(res.body.currentCycle.dueDate).toBe(due);
        });

        it("a one-time purchase has no billing period and is due on its start date", async () => {
            const { billingPeriod: _unused, ...oneTime } = body(await newMethod(alice), { subscriptionType: "one_time", startDate: "2026-11-02" });
            const res = await post("/subscriptions", alice, oneTime);
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ subscriptionType: "one_time", billingPeriod: null, currentCycle: { dueDate: "2026-11-02", status: "paid" } });
        });

        it("the links are optional, and an empty field means no link", async () => {
            const res = await post("/subscriptions", alice, body(await newMethod(alice), { renewalLink: "", cancellationLink: undefined }));
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ renewalLink: null, cancellationLink: null });
        });

        it("SEC-043: the billing row records who created it and the request id the server gave", async () => {
            const res = await post("/subscriptions", alice, body(await newMethod(alice))).set("X-Request-Id", "forged-by-client");
            const id = res.headers["x-request-id"];
            expect(id).toMatch(/^[0-9a-f-]{36}$/);
            expect(id).not.toBe("forged-by-client");
            const billing = await db.admin.query("SELECT created_by, request_id FROM billing WHERE subscription_id = $1", [res.body.id]);
            expect(billing.rows[0]).toEqual({ created_by: "user", request_id: id });
        });

        it("the subscription and its billing row are saved together or not at all (FR-011)", async () => {
            const pm = await newMethod(alice);
            const repo = createSubscriptionRepository(db.app);
            const before = await rows("subscriptions", alice.id);
            await expect(
                repo.createWithFirstBilling(
                    alice.id,
                    { ...body(pm), billingPeriod: "monthly", subscriptionType: "recurring", renewalLink: null, cancellationLink: null } as never,
                    { dueDate: "not-a-date", requestId: "r" },
                ),
            ).rejects.toThrow();
            expect(await rows("subscriptions", alice.id)).toBe(before);
        });
    });

    describe("SEC-031 / SEC-029: no access to other people's data", () => {
        it("another user's payment method is refused, with the same answer as one that does not exist", async () => {
            const bobMethod = await newMethod(bob);
            const before = await rows("subscriptions", alice.id);
            const bobBefore = await rows("subscriptions", bob.id);
            const theirs = await post("/subscriptions", alice, body(bobMethod));
            const missing = await post("/subscriptions", alice, body("99999999-9999-4999-8999-999999999999"));
            expect(theirs.status).toBe(400);
            expect(theirs.body).toEqual(missing.body);
            expect(await rows("subscriptions", alice.id)).toBe(before);
            expect(await rows("subscriptions", bob.id)).toBe(bobBefore);
        });

        it("a user cannot create a subscription for someone else by sending a user id", async () => {
            const res = await post("/subscriptions", alice, { ...body(await newMethod(alice)), userId: bob.id });
            expect(res.status).toBe(400);
            expect(await rows("subscriptions", bob.id)).toBe(0);
        });

        it("each user lists only their own subscriptions, and totals differ", async () => {
            const lena = await createUser(db);
            const mo = await createUser(db);
            const [l, m] = [
                { ...lena, cookie: await sessionCookie(keys, lena.id) },
                { ...mo, cookie: await sessionCookie(keys, mo.id) },
            ];
            const lenaMethod = await newMethod(l);
            const moMethod = await newMethod(m);
            for (const name of ["L1", "L2", "L3"]) await post("/subscriptions", l, body(lenaMethod, { name }));
            await post("/subscriptions", m, body(moMethod, { name: "M1" }));

            const lenaList = (await get("/subscriptions?status=active", l)).body;
            const moList = (await get("/subscriptions?status=active", m)).body;
            expect(lenaList.map((s: { name: string }) => s.name).sort()).toEqual(["L1", "L2", "L3"]);
            expect(moList.map((s: { name: string }) => s.name)).toEqual(["M1"]);
        });
    });

    describe("listing (Story 3 groundwork): status filter and order", () => {
        it("lists active subscriptions with the soonest due date first, and rejects a bad status", async () => {
            const nina = await createUser(db);
            const n = { ...nina, cookie: await sessionCookie(keys, nina.id) };
            const pm = await newMethod(n);
            await post("/subscriptions", n, body(pm, { name: "Later", startDate: "2026-12-01" }));
            await post("/subscriptions", n, body(pm, { name: "Sooner", startDate: "2026-03-01" }));
            const list = (await get("/subscriptions?status=active", n)).body;
            expect(list.map((s: { name: string }) => s.name)).toEqual(["Sooner", "Later"]);
            expect((await get("/subscriptions?status=inactive", n)).body).toEqual([]);
            expect((await get("/subscriptions?status=deleted", n)).status).toBe(400);
            expect((await get("/subscriptions", n)).status).toBe(400);
            expect((await get("/subscriptions?status=active&sort=name;DROP", n)).status).toBe(400);
        });
    });

    describe("SEC-030: nothing but the documented fields is accepted", () => {
        it.each([
            ["status", "inactive"], ["billingStatus", "paid"], ["userId", "x"], ["user_id", "x"], ["id", "x"],
            ["createdAt", "2020-01-01"], ["currentCycle", {}], ["isAdmin", true],
        ])("a body with %s is rejected and nothing is created", async (field, value) => {
            const pm = await newMethod(alice);
            const before = await rows("subscriptions", alice.id);
            const res = await post("/subscriptions", alice, { ...body(pm), [field]: value });
            expect(res.status).toBe(400);
            expect(await rows("subscriptions", alice.id)).toBe(before);
        });
    });

    describe("SEC-033, SEC-035, SEC-038: input validation", () => {
        const bad: Array<[string, Record<string, unknown>, string]> = [
            ["zero cost", { cost: 0 }, "cost"],
            ["negative cost", { cost: -1 }, "cost"],
            ["three decimals", { cost: 1.005 }, "cost"],
            ["cost as text", { cost: "15.49" }, "cost"],
            ["huge cost", { cost: 1e12 }, "cost"],
            ["empty name", { name: "   " }, "name"],
            ["name too long", { name: "x".repeat(101) }, "name"],
            ["name with a line break", { name: "a\nb" }, "name"],
            ["name that is not text", { name: 5 }, "name"],
            ["category too long", { category: "x".repeat(51) }, "category"],
            ["impossible date", { startDate: "2026-02-30" }, "startDate"],
            ["date with a time", { startDate: "2026-02-01T00:00:00Z" }, "startDate"],
            ["a date in words", { startDate: "yesterday" }, "startDate"],
            ["year 1999", { startDate: "1999-12-31" }, "startDate"],
            ["year 2101", { startDate: "2101-01-01" }, "startDate"],
            ["recurring without a period", { billingPeriod: undefined }, "billingPeriod"],
            ["unknown period", { billingPeriod: "weekly" }, "billingPeriod"],
            ["one-time with a period", { subscriptionType: "one_time" }, "billingPeriod"],
            ["unknown type", { subscriptionType: "lifetime" }, "subscriptionType"],
            ["javascript: link", { renewalLink: "javascript:alert(1)" }, "renewalLink"],
            ["data: link", { cancellationLink: "data:text/html,<script>1</script>" }, "cancellationLink"],
            ["vbscript: link", { renewalLink: "vbscript:msgbox(1)" }, "renewalLink"],
            ["ftp link", { renewalLink: "ftp://example.com" }, "renewalLink"],
            ["scheme-less link", { renewalLink: "//example.com" }, "renewalLink"],
            ["https without the slashes (a valid URL the database would refuse)", { renewalLink: "https:example.com" }, "renewalLink"],
            ["link with a password in it", { renewalLink: "https://user:pass@example.com" }, "renewalLink"],
            ["link over 2048 characters", { renewalLink: `https://example.com/${"a".repeat(2048)}` }, "renewalLink"],
            ["autoRenews as text", { autoRenews: "yes" }, "autoRenews"],
            ["payment method that is not a uuid", { paymentMethodId: "1 OR 1=1" }, "paymentMethodId"],
        ];

        it.each(bad)("rejects %s", async (_name, overrides, field) => {
            const pm = await newMethod(alice);
            const before = await rows("subscriptions", alice.id);
            const res = await post("/subscriptions", alice, body(pm, overrides));
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe("VALIDATION_ERROR");
            expect(res.body.error.field).toBe(field);
            expect(await rows("subscriptions", alice.id)).toBe(before);
        });

        it.each([null, "text", 5, [], [{}]])("rejects the body %j", async (payload) => {
            expect((await post("/subscriptions", alice, payload)).status).toBe(400);
        });

        it.each([
            "'; DROP TABLE subscriptions; --",
            "' OR '1'='1",
            "Robert'); DELETE FROM billing; --",
            "${process.exit(1)}",
            "<img src=x onerror=alert(1)>",
        ])("SEC-033/SEC-036: the text %j is stored and returned as plain text, and nothing else happens", async (text) => {
            const res = await post("/subscriptions", alice, body(await newMethod(alice), { name: text, category: text.slice(0, 50) }));
            expect(res.status).toBe(201);
            expect(res.body.name).toBe(text);
            const tables = await db.admin.query("SELECT to_regclass('public.subscriptions') AS s, to_regclass('public.billing') AS b");
            expect(tables.rows[0].s).not.toBeNull();
            expect(tables.rows[0].b).not.toBeNull();
            expect(await rows("billing", alice.id)).toBeGreaterThan(0);
        });
    });

    describe("FR-013, SEC-045, SEC-047: the confirmation email", () => {
        it("is sent once, after saving, to the owner only, and describes only that subscription", async () => {
            // Emails go out in the background, so earlier tests' messages can still arrive: find ours by its subject.
            const res = await post("/subscriptions", bob, body(await newMethod(bob), { name: "Bob's Gym" }));
            expect(res.status).toBe(201);
            const ours = () => email.mock.calls.map(([m]) => m).filter((m) => m.subject.includes("Bob's Gym"));
            await vi.waitFor(() => expect(ours()).toHaveLength(1));
            const message = ours()[0];
            expect(message.to).toBe("bob@example.com");
            expect(message.text + message.html).not.toContain("alice@example.com");
            expect(message.text + message.html).not.toContain("Netflix");
        });

        it("a request that fails sends no email", async () => {
            const name = "NeverSent-Marker";
            await post("/subscriptions", alice, body(await newMethod(alice), { name, cost: -5 }));
            await post("/subscriptions", alice, body(bob.id, { name }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(email.mock.calls.filter(([m]) => m.subject.includes(name))).toHaveLength(0);
        });

        it("a failing email provider does not fail or undo the save, and the log has no address", async () => {
            const logged = vi.spyOn(console, "error").mockImplementation(() => {});
            const failing = supertest(buildDbTestApp({ keys, db, sendEmail: async () => { throw new Error("email provider rejected the message (validation_error)"); } }).app);
            const pm = await newMethod(alice);
            const res = await failing.post("/api/v1/subscriptions").set("Origin", ORIGIN).set("Cookie", alice.cookie).send(body(pm, { name: "Survives" }));
            expect(res.status).toBe(201);
            await vi.waitFor(() => expect(logged).toHaveBeenCalled());
            expect(JSON.stringify(logged.mock.calls)).not.toContain("alice@example.com");
            expect(await rows("subscriptions", alice.id)).toBeGreaterThan(0);
            logged.mockRestore();
        });
    });
});

describe.skipIf(!local)("the connection pool under load (the system's bottleneck)", () => {
    it("answers 503 quickly when no database connection frees up, then recovers", async () => {
        const db = connect(local!, { max: 1, connectionTimeoutMillis: 150 });
        const keys = await createTestKeys();
        const user = await createUser(db);
        const cookie = await sessionCookie(keys, user.id);
        const api = supertest(buildDbTestApp({ keys, db }).app);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        const held = await db.app.connect(); // take the only connection
        const started = Date.now();
        const busy = await api.get("/api/v1/payment-methods").set("Cookie", cookie);
        expect(busy.status).toBe(503);
        expect(busy.body).toEqual({ error: { code: "SERVICE_UNAVAILABLE", message: "The service is busy. Try again in a moment" } });
        expect(Date.now() - started).toBeLessThan(2000);

        held.release();
        expect((await api.get("/api/v1/payment-methods").set("Cookie", cookie)).status).toBe(200);
        logged.mockRestore();
        await db.close();
    });
});
