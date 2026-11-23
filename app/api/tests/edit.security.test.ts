// Story 8 (edit details) security tests: only the editable fields change (FR-030), never the
// status, start date or ledger; stale saves are refused (optimistic concurrency); strict input
// (SEC-030), ownership (SEC-029, SEC-031) and the API role's limits.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withUserContext } from "../src/db/pool.js";
import { addDays } from "../src/domain/billingDates.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, createTestKeys, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");

describe.skipIf(!local)("Story 8 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let api: ReturnType<typeof supertest>;
    const outbox: EmailMessage[] = [];
    const today = new Date().toISOString().slice(0, 10);

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        api = supertest(buildDbTestApp({ keys, db, sendEmail: async (m) => void outbox.push(m) }).app);
    });
    afterAll(() => db.close());

    async function person() {
        const user = await createUser(db);
        return { ...user, pm: await addPaymentMethod(db, user.id), cookie: await sessionCookie(keys, user.id) };
    }
    type Person = Awaited<ReturnType<typeof person>>;
    async function subscription(owner: Person, extra: Parameters<typeof addSubscription>[3] = {}) {
        const id = await addSubscription(db, owner.id, owner.pm, { name: "Netflix", renewalLink: "https://netflix.example/renew", ...extra });
        await addBilling(db, owner.id, id, owner.pm, addDays(today, 10));
        return id;
    }
    const detail = async (owner: Person, id: string) => (await api.get(`/api/v1/subscriptions/${id}`).set("Cookie", owner.cookie)).body;
    const edit = (owner: Person, id: string, body: object) =>
        api.patch(`/api/v1/subscriptions/${id}`).set("Origin", ORIGIN).set("Cookie", owner.cookie).send(body);
    const fresh = async (owner: Person, id: string) => ({ expectedUpdatedAt: (await detail(owner, id)).updatedAt });
    const ledger = async (id: string) =>
        (await db.admin.query("SELECT due_date, status, amount, payment_method_id FROM billing WHERE subscription_id = $1 ORDER BY due_date", [id])).rows;

    describe("FR-030: the editable fields", () => {
        let u: Person;
        let id: string;
        let newPm: string;
        beforeAll(async () => {
            u = await person();
            newPm = await addPaymentMethod(db, u.id);
            id = await subscription(u);
        });

        it("every editable field changes; status, start date, next due date and the ledger do not; no email", async () => {
            const before = await detail(u, id);
            const ledgerBefore = await ledger(id);
            const res = await edit(u, id, {
                expectedUpdatedAt: before.updatedAt,
                name: "Netflix Premium",
                category: "Streaming",
                cost: 22.99,
                billingPeriod: "annually",
                paymentMethodId: newPm,
                cancellationLink: "https://netflix.example/cancel",
                autoRenews: false,
            });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                name: "Netflix Premium", category: "Streaming", cost: 22.99, billingPeriod: "annually",
                paymentMethod: { id: newPm }, cancellationLink: "https://netflix.example/cancel", autoRenews: false,
                status: before.status, startDate: before.startDate, currentCycle: before.currentCycle,
            });
            expect(res.body.renewalLink).toBe("https://netflix.example/renew"); // not sent, so kept
            expect(await ledger(id)).toEqual(ledgerBefore);
            await new Promise((r) => setTimeout(r, 50));
            expect(outbox.filter((m) => m.to === u.email)).toHaveLength(0);
        });

        it("an empty link clears it; a link that is not sent is kept", async () => {
            const res = await edit(u, id, { ...(await fresh(u, id)), renewalLink: "" });
            expect(res.status).toBe(200);
            expect(res.body.renewalLink).toBeNull();
            expect(res.body.cancellationLink).toBe("https://netflix.example/cancel");
        });

        it("an inactive subscription can still be corrected", async () => {
            const gone = await subscription(u);
            await db.admin.query("UPDATE subscriptions SET status = 'inactive' WHERE id = $1", [gone]);
            const res = await edit(u, gone, { ...(await fresh(u, gone)), name: "Fixed typo" });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ name: "Fixed typo", status: "inactive" });
        });
    });

    describe("optimistic concurrency: a stale save is refused, not silently applied", () => {
        it("a save based on an older version is a 409 and changes nothing", async () => {
            const u = await person();
            const id = await subscription(u);
            const opened = await fresh(u, id);
            expect((await edit(u, id, { ...opened, name: "First tab" })).status).toBe(200);
            const second = await edit(u, id, { ...opened, name: "Second tab" });
            expect(second.status).toBe(409);
            expect((await detail(u, id)).name).toBe("First tab");
        });

        it("a cancellation since the form was opened makes the save stale", async () => {
            const u = await person();
            const id = await subscription(u);
            const opened = await fresh(u, id);
            await api.post(`/api/v1/subscriptions/${id}/cancel`).set("Origin", ORIGIN).set("Cookie", u.cookie);
            expect((await edit(u, id, { ...opened, cost: 1 })).status).toBe(409);
        });

        it("two saves of the same version at once: one 200, one 409", async () => {
            const u = await person();
            const id = await subscription(u);
            const opened = await fresh(u, id);
            const results = await Promise.all([edit(u, id, { ...opened, name: "A" }), edit(u, id, { ...opened, name: "B" })]);
            expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        });
    });

    describe("rules carried over from create", () => {
        let u: Person;
        let id: string;
        beforeAll(async () => {
            u = await person();
            id = await subscription(u);
        });

        it("BR-017: a billing period on a one-time purchase is a 400", async () => {
            const once = await subscription(u, { type: "one_time", period: null });
            const res = await edit(u, once, { ...(await fresh(u, once)), billingPeriod: "monthly" });
            expect(res.status).toBe(400);
            expect(res.body.error.field).toBe("billingPeriod");
        });

        it("SEC-029: another user's or an inactive payment method gets the same 400", async () => {
            const other = await person();
            const inactive = await addPaymentMethod(db, u.id);
            await db.admin.query("UPDATE payment_methods SET is_active = false WHERE id = $1", [inactive]);
            const theirs = await edit(u, id, { ...(await fresh(u, id)), paymentMethodId: other.pm });
            const off = await edit(u, id, { ...(await fresh(u, id)), paymentMethodId: inactive });
            expect(theirs.status).toBe(400);
            expect(off.body).toEqual(theirs.body);
        });

        it.each([
            ["a status", { status: "active" }],
            ["a start date", { startDate: "2020-01-01" }],
            ["a due date", { dueDate: "2030-01-01" }],
            ["the subscription type", { subscriptionType: "one_time" }],
            ["a user id", { userId: crypto.randomUUID() }],
            ["a javascript: link", { renewalLink: "javascript:alert(1)" }],
            ["a link with a password", { cancellationLink: "https://user:pass@example.com" }],
            ["a name with a line break", { name: "Net\nflix" }],
            ["an empty name", { name: "   " }],
            ["a cost of zero", { cost: 0 }],
            ["nothing to change", {}],
        ])("%s is a 400 and changes nothing", async (_label, body) => {
            const before = await detail(u, id);
            expect((await edit(u, id, { expectedUpdatedAt: before.updatedAt, ...body })).status).toBe(400);
            expect(await detail(u, id)).toEqual(before);
        });

        it("without expectedUpdatedAt it is a 400", async () => {
            expect((await edit(u, id, { name: "x" })).status).toBe(400);
        });
    });

    describe("SEC-021, SEC-031: who may edit", () => {
        it("another user's subscription, an unknown id and a malformed id give the identical 404, and nothing changes", async () => {
            const u = await person();
            const other = await person();
            const id = await subscription(u);
            const opened = await fresh(u, id);
            const theirs = await edit(other, id, { ...opened, name: "Hijacked" });
            const unknown = await edit(u, crypto.randomUUID(), { ...opened, name: "x" });
            const malformed = await edit(u, "not-a-uuid", { ...opened, name: "x" });
            expect(theirs.status).toBe(404);
            expect(unknown.body).toEqual(theirs.body);
            expect(malformed.body).toEqual(theirs.body);
            expect((await detail(u, id)).name).toBe("Netflix");
        });

        it("without a session it is a 401; without the app's Origin it is a 403", async () => {
            const u = await person();
            const id = await subscription(u);
            const opened = await fresh(u, id);
            expect((await api.patch(`/api/v1/subscriptions/${id}`).set("Origin", ORIGIN).send({ ...opened, name: "x" })).status).toBe(401);
            expect((await api.patch(`/api/v1/subscriptions/${id}`).set("Origin", "https://evil.example").set("Cookie", u.cookie).send({ ...opened, name: "x" })).status).toBe(403);
        });
    });

    describe("least privilege: what the API role still cannot change", () => {
        it.each([
            "UPDATE subscriptions SET subscription_type = 'one_time', billing_period = NULL",
            "UPDATE subscriptions SET user_id = gen_random_uuid()",
            "UPDATE subscriptions SET created_at = now()",
            "UPDATE billing SET amount = 1",
        ])("is refused: %s", async (sql) => {
            const u = await person();
            await expect(withUserContext(db.app, u.id, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
        });
    });
});
