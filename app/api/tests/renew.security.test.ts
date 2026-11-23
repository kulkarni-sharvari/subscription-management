// Story 6 ("I renewed") security tests: the renewal rules, idempotency (SEC-041), ownership
// (SEC-029, SEC-031), strict input (SEC-030), the ledger staying append-only (BR-021) and the
// API role's new update rights. Users are in UTC, so "today" is the UTC date.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withUserContext } from "../src/db/pool.js";
import { addBillingPeriod, addDays } from "../src/domain/billingDates.js";
import { MAX_PAYMENTS_PER_RENEWAL, planRenewal, renewalInfo, RenewalRefused, type RenewalState } from "../src/domain/renewal.js";
import { subscriptionRenewedEmail } from "../src/email/templates.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, createTestKeys, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");

describe("the renewal rules (pure)", () => {
    const base: RenewalState = { status: "active-unknown", subscriptionType: "recurring", billingPeriod: "monthly", currentDue: "2026-10-01", today: "2026-12-15" };
    const dues = (plan: { cycles: Array<{ dueDate: string }> }) => plan.cycles.map((c) => c.dueDate);
    const refusal = (fn: () => unknown) => {
        try {
            fn();
            return null;
        } catch (err) {
            return err instanceof RenewalRefused ? { kind: err.kind, field: err.field } : "other";
        }
    };

    it("one missed renewal (lapsed yesterday): one new cycle, no question asked", () => {
        expect(dues(planRenewal({ ...base, currentDue: "2026-12-14" }, {}))).toEqual(["2027-01-14"]);
    });

    it("several missed: the user must say what happened", () => {
        expect(renewalInfo(base)).toEqual({ allowed: true, missedDates: ["2026-10-01", "2026-11-01", "2026-12-01"], nextDueIfPaidAll: "2027-01-01" });
        expect(refusal(() => planRenewal(base, {}))).toEqual({ kind: "invalid", field: "missed" });
    });

    it("'I kept paying' records one payment per missed renewal; only the newest is not a catch-up", () => {
        expect(planRenewal(base, { missed: "paid_all" }).cycles).toEqual([
            { dueDate: "2026-11-01", catchUp: true },
            { dueDate: "2026-12-01", catchUp: true },
            { dueDate: "2027-01-01", catchUp: false },
        ]);
    });

    it("a new billing period applies from the newest payment on; the missed ones keep the old period", () => {
        expect(dues(planRenewal(base, { missed: "paid_all" }, "annually"))).toEqual(["2026-11-01", "2026-12-01", "2027-12-01"]);
        expect(dues(planRenewal({ ...base, currentDue: "2026-12-14" }, {}, "6_months"))).toEqual(["2027-06-14"]);
        expect(dues(planRenewal(base, { missed: "restarted", restartDate: "2026-12-10" }, "annually"))).toEqual(["2027-12-10"]);
    });

    it("'I restarted' starts a new streak on that date, paid since then", () => {
        expect(planRenewal(base, { missed: "restarted", restartDate: "2026-12-10" })).toEqual({ cycles: [{ dueDate: "2027-01-10", catchUp: false }], newStartDate: "2026-12-10" });
        const sinceOctober = planRenewal(base, { missed: "restarted", restartDate: "2026-10-15" });
        expect(dues(sinceOctober)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15"]);
        expect(sinceOctober.newStartDate).toBe("2026-10-15");
        expect(sinceOctober.cycles.every((c) => !c.catchUp)).toBe(true); // the restart is the new plan
    });

    it.each([
        ["on the old due date", "2026-10-01"],
        ["before it", "2026-09-20"],
        ["in the future", "2026-12-16"],
    ])("a restart date %s is refused", (_label, restartDate) => {
        expect(refusal(() => planRenewal(base, { missed: "restarted", restartDate }))).toEqual({ kind: "invalid", field: "restartDate" });
    });

    it("a restart cannot be recorded when nothing was missed", () => {
        const early = { ...base, status: "active" as const, currentDue: "2026-12-18" };
        expect(refusal(() => planRenewal(early, { missed: "restarted", restartDate: "2026-12-10" }))).toEqual({ kind: "invalid", field: "missed" });
    });

    it("early renewal: allowed within 5 days of the renewal date, refused before", () => {
        expect(dues(planRenewal({ ...base, status: "active", currentDue: "2026-12-20" }, {}))).toEqual(["2027-01-20"]);
        expect(renewalInfo({ ...base, status: "active", currentDue: "2026-12-21" })).toEqual({ allowed: false, reason: "too_early", opensOn: "2026-12-16" });
        expect(refusal(() => planRenewal({ ...base, status: "active", currentDue: "2026-12-21" }, {}))).toEqual({ kind: "conflict", field: undefined });
    });

    it("cancelled and one-time subscriptions do not renew", () => {
        expect(refusal(() => planRenewal({ ...base, status: "inactive" }, {}))).toEqual({ kind: "conflict", field: undefined });
        expect(refusal(() => planRenewal({ ...base, subscriptionType: "one_time", billingPeriod: null }, {}))).toEqual({ kind: "conflict", field: undefined });
    });

    it(`more than ${MAX_PAYMENTS_PER_RENEWAL} missed payments must be recorded as a restart`, () => {
        const longAgo = { ...base, currentDue: "2024-01-01" };
        expect(refusal(() => planRenewal(longAgo, { missed: "paid_all" }))).toEqual({ kind: "invalid", field: "missed" });
        expect(dues(planRenewal(longAgo, { missed: "restarted", restartDate: "2026-12-01" }))).toEqual(["2027-01-01"]);
    });

    it("month ends clamp (31 Jan + 1 month = 28 Feb)", () => {
        expect(dues(planRenewal({ ...base, currentDue: "2027-01-31", today: "2027-02-01" }, {}))).toEqual(["2027-02-28"]);
    });
});

describe("SEC-047: the renewed email escapes every value", () => {
    it("markup in a name arrives as text", () => {
        const { html } = subscriptionRenewedEmail(
            {
                id: "x", name: "<script>alert(1)</script>", category: "c", cost: 5, billingPeriod: "monthly", subscriptionType: "recurring", status: "active",
                autoRenews: false, paymentMethod: { id: "p", type: "credit_card" }, currentCycle: { dueDate: "2027-01-01", status: "paid" },
                renewalLink: null, cancellationLink: null, startDate: "2026-01-01", createdAt: new Date(), updatedAt: new Date(),
            },
            1,
        );
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });
});

describe.skipIf(!local)("Story 6 against the database", () => {
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

    const sentTo = (address: string) => outbox.filter((m) => m.to === address);
    async function person() {
        const user = await createUser(db);
        return { ...user, pm: await addPaymentMethod(db, user.id), cookie: await sessionCookie(keys, user.id) };
    }
    type Person = Awaited<ReturnType<typeof person>>;
    // A monthly subscription whose current cycle is due on `due`; lapsed if that date has passed.
    async function subscription(owner: Person, due: string, extra: Parameters<typeof addSubscription>[3] = {}) {
        const id = await addSubscription(db, owner.id, owner.pm, { name: `Sub-${due}`, ...extra });
        await addBilling(db, owner.id, id, owner.pm, due);
        if (due < today) {
            await db.admin.query("UPDATE subscriptions SET status = 'active-unknown' WHERE id = $1", [id]);
            await db.admin.query("UPDATE billing SET status = 'due' WHERE subscription_id = $1", [id]);
        }
        return id;
    }
    const renew = (owner: Person, id: string, body: object = {}, key: string | null = crypto.randomUUID()) => {
        const req = api.post(`/api/v1/subscriptions/${id}/renew`).set("Origin", ORIGIN).set("Cookie", owner.cookie);
        return (key ? req.set("Idempotency-Key", key) : req).send(body);
    };
    const ledger = async (id: string) =>
        (await db.admin.query("SELECT due_date, status, amount FROM billing WHERE subscription_id = $1 ORDER BY due_date", [id])).rows.map(
            (r) => `${r.due_date}:${r.status}:${r.amount}`,
        );

    describe("a subscription that lapsed yesterday", () => {
        let u: Person;
        let id: string;
        const due = addDays(today, -1);
        const key = crypto.randomUUID();

        beforeAll(async () => {
            u = await person();
            id = await subscription(u, due);
        });

        it("the detail view says it can be renewed, with the one missed date", async () => {
            const res = await api.get(`/api/v1/subscriptions/${id}`).set("Cookie", u.cookie);
            expect(res.body.renewal).toEqual({ allowed: true, missedDates: [due], nextDueIfPaidAll: addBillingPeriod(due, "monthly") });
        });

        it("FR-031: renewing makes it active with a new paid cycle; the lapsed one is left as it was", async () => {
            const res = await renew(u, id, {}, key);
            expect(res.status).toBe(200);
            expect(res.body.status).toBe("active");
            expect(res.body.currentCycle).toEqual({ dueDate: addBillingPeriod(due, "monthly"), status: "paid" });
            expect(await ledger(id)).toEqual([`${due}:due:15.49`, `${addBillingPeriod(due, "monthly")}:paid:15.49`]);
        });

        it("FR-034: one 'Renewal recorded' email", async () => {
            await expect.poll(() => sentTo(u.email).length).toBe(1);
            expect(sentTo(u.email)[0].subject).toBe(`Renewal recorded: Sub-${due}`);
        });

        it("SEC-041: the same key again records nothing and sends nothing", async () => {
            const again = await renew(u, id, {}, key);
            expect(again.status).toBe(200);
            expect(await ledger(id)).toHaveLength(2);
            expect(sentTo(u.email)).toHaveLength(1);
        });

        it("a new key right after is a 409: it is now a month from renewal", async () => {
            const res = await renew(u, id);
            expect(res.status).toBe(409);
            expect(await ledger(id)).toHaveLength(2);
        });
    });

    it("SEC-041: three double-clicks at once with different keys record one renewal", async () => {
        const u = await person();
        const id = await subscription(u, addDays(today, -1));
        const results = await Promise.all([renew(u, id), renew(u, id), renew(u, id)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        expect(await ledger(id)).toHaveLength(2);
    });

    it("SEC-041: the same key sent three times at once records once", async () => {
        const u = await person();
        const id = await subscription(u, addDays(today, -1));
        const key = crypto.randomUUID();
        const results = await Promise.all([renew(u, id, {}, key), renew(u, id, {}, key), renew(u, id, {}, key)]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(await ledger(id)).toHaveLength(2);
    });

    describe("several renewals missed", () => {
        let u: Person;
        let lapsedDue: string;
        let missed: string[];

        beforeAll(async () => {
            u = await person();
            // Due about three months ago, so several renewal dates have passed since.
            const y = addDays(today, -1);
            const [yy, mm, dd] = y.split("-").map(Number);
            const back = new Date(Date.UTC(yy, mm - 1 - 3, Math.min(dd, 28))).toISOString().slice(0, 10);
            lapsedDue = back;
            missed = [back, addBillingPeriod(back, "monthly"), addBillingPeriod(addBillingPeriod(back, "monthly"), "monthly")];
            const fourth = addBillingPeriod(missed[2], "monthly");
            if (fourth <= today) missed.push(fourth);
        });

        it("without an answer it is a 400 on 'missed', and nothing is recorded", async () => {
            const id = await subscription(u, lapsedDue);
            const res = await renew(u, id);
            expect(res.status).toBe(400);
            expect(res.body.error.field).toBe("missed");
            expect(await ledger(id)).toHaveLength(1);
        });

        it("'I kept paying' records one paid cycle per missed renewal", async () => {
            const id = await subscription(u, lapsedDue);
            const res = await renew(u, id, { missed: "paid_all" });
            expect(res.status).toBe(200);
            const expected = missed.map((d) => `${addBillingPeriod(d, "monthly")}:paid:15.49`);
            expect(await ledger(id)).toEqual([`${lapsedDue}:due:15.49`, ...expected]);
            expect(res.body.currentCycle.dueDate > today).toBe(true);
        });

        it("'I restarted' records one cycle from the restart and moves the start date; the gap stays unpaid", async () => {
            const id = await subscription(u, lapsedDue);
            const restart = addDays(today, -2);
            const res = await renew(u, id, { missed: "restarted", restartDate: restart });
            expect(res.status).toBe(200);
            expect(res.body.startDate).toBe(restart);
            expect(await ledger(id)).toEqual([`${lapsedDue}:due:15.49`, `${addBillingPeriod(restart, "monthly")}:paid:15.49`]);
        });

        it("a restart date in the future, or a restart date without 'restarted', is a 400", async () => {
            const id = await subscription(u, lapsedDue);
            expect((await renew(u, id, { missed: "restarted", restartDate: addDays(today, 1) })).body.error.field).toBe("restartDate");
            expect((await renew(u, id, { restartDate: addDays(today, -2) })).body.error.field).toBe("restartDate");
            expect((await renew(u, id, { missed: "restarted" })).body.error.field).toBe("restartDate");
            expect(await ledger(id)).toHaveLength(1);
        });
    });

    describe("a changed cost or payment method", () => {
        it("applies to the new cycle and going forward; earlier cycles keep their amount", async () => {
            const u = await person();
            const newPm = await addPaymentMethod(db, u.id);
            const due = addDays(today, -1);
            const id = await subscription(u, due);
            const res = await renew(u, id, { cost: 19.99, paymentMethodId: newPm });
            expect(res.status).toBe(200);
            expect(res.body.cost).toBe(19.99);
            expect(res.body.paymentMethod.id).toBe(newPm);
            expect(await ledger(id)).toEqual([`${due}:due:15.49`, `${addBillingPeriod(due, "monthly")}:paid:19.99`]);
        });

        it("with missed renewals, the catch-up payments keep the old cost and card; only the newest cycle uses the new ones", async () => {
            const u = await person();
            const newPm = await addPaymentMethod(db, u.id);
            const [yy, mm] = today.split("-").map(Number);
            const lapsedDue = new Date(Date.UTC(yy, mm - 1 - 2, 5)).toISOString().slice(0, 10); // the 5th, two months back
            const id = await subscription(u, lapsedDue);
            const res = await renew(u, id, { missed: "paid_all", cost: 19.99, paymentMethodId: newPm });
            expect(res.status).toBe(200);
            const rows = (await db.admin.query("SELECT amount, payment_method_id FROM billing WHERE subscription_id = $1 AND status = 'paid' ORDER BY due_date", [id])).rows;
            const newest = rows.pop();
            expect(newest).toEqual({ amount: "19.99", payment_method_id: newPm });
            expect(rows.length).toBeGreaterThanOrEqual(1);
            for (const row of rows) expect(row).toEqual({ amount: "15.49", payment_method_id: u.pm });
        });

        it("a new billing period is saved and sets the next renewal", async () => {
            const u = await person();
            const due = addDays(today, -1);
            const id = await subscription(u, due);
            const res = await renew(u, id, { billingPeriod: "annually" });
            expect(res.status).toBe(200);
            expect(res.body.billingPeriod).toBe("annually");
            expect(res.body.currentCycle.dueDate).toBe(addBillingPeriod(due, "annually"));
            expect((await renew(u, id, { billingPeriod: "weekly" })).status).toBe(400);
        });

        it("SEC-029: another user's or an inactive payment method is refused with the same answer", async () => {
            const u = await person();
            const other = await person();
            const inactive = await addPaymentMethod(db, u.id);
            await db.admin.query("UPDATE payment_methods SET is_active = false WHERE id = $1", [inactive]);
            const id = await subscription(u, addDays(today, -1));
            const theirs = await renew(u, id, { paymentMethodId: other.pm });
            const off = await renew(u, id, { paymentMethodId: inactive });
            expect(theirs.status).toBe(400);
            expect(off.body).toEqual(theirs.body);
            expect(await ledger(id)).toHaveLength(1);
        });
    });

    describe("early renewal of an active subscription", () => {
        it("within 5 days: renewed, stays active, and no status email (the status did not change)", async () => {
            const u = await person();
            const due = addDays(today, 3);
            const id = await subscription(u, due);
            const res = await renew(u, id);
            expect(res.status).toBe(200);
            expect(res.body.currentCycle.dueDate).toBe(addBillingPeriod(due, "monthly"));
            expect(await ledger(id)).toEqual([`${due}:paid:15.49`, `${addBillingPeriod(due, "monthly")}:paid:15.49`]);
            await new Promise((r) => setTimeout(r, 50));
            expect(sentTo(u.email)).toHaveLength(0);
        });

        it("more than 5 days ahead: 409, and the detail view says from when", async () => {
            const u = await person();
            const due = addDays(today, 10);
            const id = await subscription(u, due);
            expect((await renew(u, id)).status).toBe(409);
            const detail = await api.get(`/api/v1/subscriptions/${id}`).set("Cookie", u.cookie);
            expect(detail.body.renewal).toEqual({ allowed: false, reason: "too_early", opensOn: addDays(due, -5) });
        });
    });

    it("a cancelled or one-time subscription is a 409", async () => {
        const u = await person();
        const cancelled = await subscription(u, addDays(today, -1));
        await db.admin.query("UPDATE subscriptions SET status = 'inactive' WHERE id = $1", [cancelled]);
        const oneTime = await subscription(u, addDays(today, 1), { type: "one_time", period: null });
        expect((await renew(u, cancelled)).status).toBe(409);
        expect((await renew(u, oneTime)).status).toBe(409);
    });

    describe("SEC-021, SEC-030, SEC-031: who may renew, and what may be sent", () => {
        let u: Person;
        let id: string;
        beforeAll(async () => {
            u = await person();
            id = await subscription(u, addDays(today, -1));
        });

        it("another user's subscription, an unknown id and a malformed id give the identical 404", async () => {
            const other = await person();
            const theirs = await renew(other, id);
            const unknown = await renew(u, crypto.randomUUID());
            const malformed = await api.post("/api/v1/subscriptions/not-a-uuid/renew").set("Origin", ORIGIN).set("Cookie", u.cookie).set("Idempotency-Key", crypto.randomUUID());
            expect(theirs.status).toBe(404);
            expect(unknown.body).toEqual(theirs.body);
            expect(malformed.body).toEqual(theirs.body);
            expect(await ledger(id)).toHaveLength(1);
        });

        it("without a session it is a 401; without the app's Origin it is a 403", async () => {
            expect((await api.post(`/api/v1/subscriptions/${id}/renew`).set("Origin", ORIGIN).set("Idempotency-Key", crypto.randomUUID())).status).toBe(401);
            expect((await api.post(`/api/v1/subscriptions/${id}/renew`).set("Origin", "https://evil.example").set("Cookie", u.cookie).set("Idempotency-Key", crypto.randomUUID())).status).toBe(403);
        });

        it.each([
            ["no Idempotency-Key", {}, null],
            ["a key that is not a UUID", {}, "abc"],
            ["a status in the body", { status: "active" }, undefined],
            ["a due date in the body", { dueDate: "2030-01-01" }, undefined],
            ["a user id in the body", { userId: crypto.randomUUID() }, undefined],
            ["a cost of zero", { cost: 0 }, undefined],
            ["a cost with three decimals", { cost: 1.234 }, undefined],
            ["an unknown 'missed' value", { missed: "skip" }, undefined],
        ])("%s is a 400 and records nothing", async (_label, body, key) => {
            const res = await renew(u, id, body, key === undefined ? crypto.randomUUID() : key);
            expect(res.status).toBe(400);
            expect(await ledger(id)).toHaveLength(1);
        });
    });

    describe("least privilege: what the API role may now change", () => {
        const appError = async (userId: string, sql: string, params: unknown[] = []) => {
            try {
                const r = await withUserContext(db.app, userId, (c) => c.query(sql, params));
                return { error: null, rowCount: r.rowCount };
            } catch (err) {
                return { error: (err as Error).message, rowCount: 0 };
            }
        };
        let a: Person;
        let b: Person;
        let bs: string;
        beforeAll(async () => {
            a = await person();
            b = await person();
            bs = await subscription(b, addDays(today, 20));
        });

        it.each([
            "UPDATE subscriptions SET name = 'x'",
            "UPDATE subscriptions SET category = 'x'",
            "UPDATE subscriptions SET user_id = gen_random_uuid()",
            "UPDATE subscriptions SET renewal_link = 'https://x.example'",
            "UPDATE billing SET amount = 1",
            "UPDATE billing SET status = 'paid'",
            "DELETE FROM subscriptions",
            "DELETE FROM billing",
        ])("is refused: %s", async (sql) => {
            expect((await appError(a.id, sql)).error).toMatch(/permission denied/);
        });

        it("cannot change another user's subscription (no rows reached)", async () => {
            expect(await appError(a.id, "UPDATE subscriptions SET status = 'inactive', price = 1 WHERE id = $1", [bs])).toEqual({ error: null, rowCount: 0 });
            expect((await db.admin.query("SELECT status, price FROM subscriptions WHERE id = $1", [bs])).rows[0]).toEqual({ status: "active", price: "15.49" });
        });

        it("cannot point its own subscription at another user's payment method", async () => {
            const mine = await subscription(a, addDays(today, 20));
            expect((await appError(a.id, "UPDATE subscriptions SET payment_method_id = $2 WHERE id = $1", [mine, b.pm])).error).toMatch(/foreign key/);
        });
    });
});
