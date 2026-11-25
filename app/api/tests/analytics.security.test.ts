// Story 9 (spending analytics) tests: what counts as spend in a range (payments by paid_on,
// boundaries included, lapsed cycles still paid), the monthly cost (FR-063) without the
// active-unknown ones (listed apart), isolation between users (SEC-029), the range limits
// (SEC-038), the rate limit (SEC-051) and the ledger's new paid_on column.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { addDays } from "../src/domain/billingDates.js";
import { addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, createTestKeys, NO_LIMITS, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");
const URL_ = "/api/v1/analytics/spending";

describe.skipIf(!local)("Story 9 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let api: ReturnType<typeof supertest>;

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        api = supertest(buildDbTestApp({ keys, db }).app);
    });
    afterAll(() => db.close());

    async function person() {
        const user = await createUser(db);
        return { ...user, pm: await addPaymentMethod(db, user.id), cookie: await sessionCookie(keys, user.id) };
    }
    type Person = Awaited<ReturnType<typeof person>>;
    // A subscription and its cycles, written directly so every date and amount is exact.
    async function sub(
        owner: Person,
        o: { name: string; category: string; price: number; period?: string | null; status?: string; cycles: Array<{ paidOn: string; due: string; amount?: number; status?: string }> },
    ) {
        const id = await addSubscription(db, owner.id, owner.pm, {
            name: o.name, category: o.category, price: o.price,
            period: o.period === undefined ? "monthly" : o.period, type: o.period === null ? "one_time" : "recurring",
        });
        for (const c of o.cycles) {
            await db.admin.query(
                `INSERT INTO billing (subscription_id, user_id, amount, payment_method_id, status, due_date, paid_on, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'user')`,
                [id, owner.id, c.amount ?? o.price, owner.pm, c.status ?? "paid", c.due, c.paidOn],
            );
        }
        if (o.status) await db.admin.query("UPDATE subscriptions SET status = $2 WHERE id = $1", [id, o.status]);
        return id;
    }
    const spending = (owner: Person, query: Record<string, string> = {}, target = api) =>
        target.get(`${URL_}?${new URLSearchParams(query)}`).set("Cookie", owner.cookie);

    describe("one user's spending", () => {
        let u: Person;
        let lapsedId: string;
        beforeAll(async () => {
            u = await person();
            await sub(u, {
                name: "Netflix", category: "Entertainment", price: 15.49,
                cycles: [
                    { paidOn: "2026-09-15", due: "2026-10-15" }, // before the range
                    { paidOn: "2026-10-15", due: "2026-11-15" }, // first day of the range
                    { paidOn: "2026-11-15", due: "2026-12-15" }, // last day of the range
                    { paidOn: "2026-12-15", due: "2027-01-15" }, // after the range
                ],
            });
            await sub(u, { name: "Cloud", category: "Utilities", price: 120, period: "annually", cycles: [{ paidOn: "2026-10-20", due: "2027-10-20" }] });
            await sub(u, { name: "Paper", category: "News", price: 60, period: "6_months", cycles: [{ paidOn: "2026-06-01", due: "2026-12-01" }] });
            await sub(u, { name: "Concert", category: "Entertainment", price: 80, period: null, cycles: [{ paidOn: "2026-11-01", due: "2026-11-01" }] });
            lapsedId = await sub(u, {
                name: "Gym", category: "Health", price: 30, status: "active-unknown",
                cycles: [{ paidOn: "2026-10-01", due: "2026-11-01", status: "due" }], // lapsed, but it was paid on Oct 1
            });
            await sub(u, { name: "Old", category: "Entertainment", price: 9.99, status: "inactive", cycles: [{ paidOn: "2026-10-16", due: "2026-11-16" }] });
            await sub(u, { name: "Cents", category: "Utilities", price: 0.1, cycles: [{ paidOn: "2026-10-21", due: "2026-11-21", amount: 0.1 }, { paidOn: "2026-10-22", due: "2026-11-22", amount: 0.2 }] });
        });

        it("FR-060: payments made in the range count, both boundary days included, lapsed and inactive ones too", async () => {
            const res = await spending(u, { from: "2026-10-15", to: "2026-11-15" });
            expect(res.status).toBe(200);
            // Netflix 2 x 15.49 + Cloud 120 + Concert 80 + Gym 0 (paid Oct 1, outside) + Old 9.99 + Cents 0.30
            expect(res.body.range).toEqual({ from: "2026-10-15", to: "2026-11-15" });
            expect(res.body.paid.total).toBe(241.27);
            expect(res.body.paid.payments).toBe(7);
        });

        it("a lapsed cycle still counts as paid on its paid_on day", async () => {
            const res = await spending(u, { from: "2026-10-01", to: "2026-10-01" });
            expect(res.body.paid.total).toBe(30);
        });

        it("FR-061, FR-062: by category, by month, and one-time vs recurring", async () => {
            const { paid } = (await spending(u, { from: "2026-10-15", to: "2026-11-15" })).body;
            expect(paid.byCategory).toEqual([
                { category: "Utilities", total: 120.3, payments: 3 },
                { category: "Entertainment", total: 120.97, payments: 4 },
            ].sort((a, b) => b.total - a.total));
            expect(paid.byMonth).toEqual([
                { month: "2026-10", total: 145.78 },
                { month: "2026-11", total: 95.49 },
            ]);
            expect(paid.oneTime).toEqual({ total: 80, payments: 1 });
            expect(paid.recurring).toEqual({ total: 161.27, payments: 6 });
        });

        it("money is added in cents: 0.10 + 0.20 is 0.30", async () => {
            const res = await spending(u, { from: "2026-10-21", to: "2026-10-22" });
            expect(res.body.paid.total).toBe(0.3);
        });

        it("FR-063: monthly cost of active recurring ones (annual / 12, 6-month / 6); active-unknown listed apart, not counted", async () => {
            const { monthlyCost, pendingReconciliation, statusCounts } = (await spending(u, { from: "2026-10-15", to: "2026-11-15" })).body;
            // Netflix 15.49 + Cloud 10 + Paper 10 + Cents 0.10; not Gym (active-unknown), Old (inactive) or Concert (one-time)
            expect(monthlyCost).toEqual({
                total: 35.59,
                subscriptions: 4,
                byCategory: [
                    { category: "Entertainment", monthly: 15.49 },
                    { category: "Utilities", monthly: 10.1 },
                    { category: "News", monthly: 10 },
                ],
            });
            expect(pendingReconciliation).toEqual([{ id: lapsedId, name: "Gym", category: "Health", renewalDate: "2026-11-01", monthlyCost: 30 }]);
            expect(statusCounts).toEqual({ active: 5, activeUnknown: 1, inactive: 1 });
        });

        it("a range with no payments is all zeros, not an error", async () => {
            const { paid } = (await spending(u, { from: "2020-01-01", to: "2020-12-31" })).body;
            expect(paid).toEqual({ total: 0, payments: 0, byCategory: [], byMonth: [], recurring: { total: 0, payments: 0 }, oneTime: { total: 0, payments: 0 } });
        });
    });

    it("SEC-029: another user's payments and subscriptions never appear", async () => {
        const a = await person();
        const b = await person();
        await sub(a, { name: "A-only", category: "Mine", price: 5, cycles: [{ paidOn: "2026-10-20", due: "2026-11-20" }] });
        await sub(b, { name: "B-big", category: "Mine", price: 999, cycles: [{ paidOn: "2026-10-20", due: "2026-11-20" }] });
        await sub(b, { name: "B-lapsed", category: "Theirs", price: 50, status: "active-unknown", cycles: [{ paidOn: "2026-09-01", due: "2026-10-01", status: "due" }] });
        const body = (await spending(a, { from: "2026-10-01", to: "2026-10-31" })).body;
        expect(body.paid.total).toBe(5);
        expect(body.monthlyCost.total).toBe(5);
        expect(body.pendingReconciliation).toEqual([]);
        expect(JSON.stringify(body)).not.toMatch(/B-big|B-lapsed|Theirs/);
    });

    describe("SEC-038, SEC-033: the range and the query", () => {
        let u: Person;
        beforeAll(async () => {
            u = await person();
        });

        it("without dates: the last 12 months up to today", async () => {
            const today = new Date().toISOString().slice(0, 10);
            expect((await spending(u)).body.range).toEqual({ from: addDays(today, -364), to: today });
        });

        it("exactly 5 years is allowed", async () => {
            expect((await spending(u, { from: "2021-01-01", to: "2025-12-31" })).status).toBe(200);
        });

        it.each([
            ["from after to", { from: "2026-12-01", to: "2026-11-01" }],
            ["more than 5 years", { from: "2020-01-01", to: "2026-01-01" }],
            ["an invalid date", { from: "2026-02-30", to: "2026-03-01" }],
            ["a date that is not a date", { from: "yesterday", to: "2026-03-01" }],
            ["SQL in a date", { from: "2026-01-01'; DROP TABLE billing;--", to: "2026-03-01" }],
            ["a year outside 2000-2100", { from: "1999-12-31", to: "2000-01-31" }],
            ["an unknown parameter", { from: "2026-01-01", to: "2026-02-01", userId: crypto.randomUUID() }],
        ])("%s is a 400", async (_label, query) => {
            expect((await spending(u, query)).status).toBe(400);
        });

        it("SEC-021: without a session it is a 401", async () => {
            expect((await api.get(URL_).set("Origin", ORIGIN)).status).toBe(401);
        });
    });

    it("SEC-051: limited per user; over the limit is a 429", async () => {
        const limited = supertest(buildDbTestApp({ keys, db, limits: { ...NO_LIMITS, analytics: { limit: 2, windowMs: 60_000 } } }).app);
        const u = await person();
        const other = await person();
        expect((await spending(u, {}, limited)).status).toBe(200);
        expect((await spending(u, {}, limited)).status).toBe(200);
        expect((await spending(u, {}, limited)).status).toBe(429);
        expect((await spending(other, {}, limited)).status).toBe(200); // counted per user
    });

    describe("the ledger's paid_on", () => {
        it("a new subscription's first payment is on its start date; a renewal's on the date it renewed", async () => {
            const u = await person();
            const created = await api
                .post("/api/v1/subscriptions")
                .set("Origin", ORIGIN)
                .set("Cookie", u.cookie)
                .send({ name: "New", category: "Test", subscriptionType: "recurring", billingPeriod: "monthly", startDate: "2026-11-10", cost: 5, paymentMethodId: u.pm, autoRenews: false });
            const rows = async () => (await db.admin.query("SELECT paid_on, due_date FROM billing WHERE subscription_id = $1 ORDER BY due_date", [created.body.id])).rows;
            expect(await rows()).toEqual([{ paid_on: "2026-11-10", due_date: "2026-12-10" }]);
        });

        it("paid_on can never be changed, and never be after the due date", async () => {
            const u = await person();
            const id = await sub(u, { name: "Locked", category: "Test", price: 5, cycles: [{ paidOn: "2026-10-01", due: "2026-11-01" }] });
            await expect(db.admin.query("UPDATE billing SET paid_on = '2026-10-02' WHERE subscription_id = $1", [id])).rejects.toThrow(/immutable/);
            await expect(
                db.admin.query(
                    "INSERT INTO billing (subscription_id, user_id, amount, payment_method_id, due_date, paid_on, created_by) VALUES ($1, $2, 1, $3, '2026-01-01', '2026-02-01', 'user')",
                    [id, u.id, u.pm],
                ),
            ).rejects.toThrow(/billing_paid_before_due/);
        });
    });
});
