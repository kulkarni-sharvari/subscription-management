// Story 7 ("I cancelled") security tests: the cancel rule, the ledger left untouched (BR-021),
// no more reminders, one email, double clicks, strict input and ownership.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withUserContext } from "../src/db/pool.js";
import { addDays } from "../src/domain/billingDates.js";
import { subscriptionCancelledEmail } from "../src/email/templates.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, createTestKeys, JOB_SECRET, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");

describe("SEC-047: the cancelled email escapes every value", () => {
    it("markup in a name arrives as text", () => {
        const { html } = subscriptionCancelledEmail({
            id: "x", name: "<img src=x onerror=alert(1)>", category: "c", cost: 5, billingPeriod: "monthly", subscriptionType: "recurring", status: "inactive",
            autoRenews: false, paymentMethod: { id: "p", type: "credit_card" }, currentCycle: null,
            renewalLink: null, cancellationLink: null, startDate: "2026-01-01", cancelledOn: "2026-11-23", createdAt: new Date(), updatedAt: new Date(),
        });
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img");
    });
});

describe.skipIf(!local)("Story 7 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let api: ReturnType<typeof supertest>;
    const outbox: EmailMessage[] = [];
    const today = new Date().toISOString().slice(0, 10);

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        // The digest job's clock: today at noon UTC, so every UTC user is past 09:00.
        api = supertest(buildDbTestApp({ keys, db, now: () => new Date(`${today}T12:00:00Z`), sendEmail: async (m) => void outbox.push(m) }).app);
    });
    afterAll(() => db.close());

    const sentTo = (address: string) => outbox.filter((m) => m.to === address);
    async function person() {
        const user = await createUser(db);
        return { ...user, pm: await addPaymentMethod(db, user.id), cookie: await sessionCookie(keys, user.id) };
    }
    type Person = Awaited<ReturnType<typeof person>>;
    async function subscription(owner: Person, due: string, name = `Sub-${due}`) {
        const id = await addSubscription(db, owner.id, owner.pm, { name });
        await addBilling(db, owner.id, id, owner.pm, due);
        if (due < today) {
            await db.admin.query("UPDATE subscriptions SET status = 'active-unknown' WHERE id = $1", [id]);
            await db.admin.query("UPDATE billing SET status = 'due' WHERE subscription_id = $1", [id]);
        }
        return id;
    }
    const cancel = (owner: Person, id: string, body?: object) =>
        api.post(`/api/v1/subscriptions/${id}/cancel`).set("Origin", ORIGIN).set("Cookie", owner.cookie).send(body);
    const ledger = async (id: string) =>
        (await db.admin.query("SELECT due_date, status, amount FROM billing WHERE subscription_id = $1 ORDER BY due_date", [id])).rows.map((r) => `${r.due_date}:${r.status}`);

    describe("a subscription that needs action", () => {
        let u: Person;
        let id: string;
        const due = addDays(today, -1);
        beforeAll(async () => {
            u = await person();
            id = await subscription(u, due, "Netflix");
        });

        it("FR-032: becomes inactive with today's date; the record is kept and the lapsed cycle stays unpaid", async () => {
            const res = await cancel(u, id);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id, status: "inactive", cancelledOn: today });
            expect(await ledger(id)).toEqual([`${due}:due`]);
            const detail = await api.get(`/api/v1/subscriptions/${id}`).set("Cookie", u.cookie);
            expect(detail.body).toMatchObject({ status: "inactive", cancelledOn: today, renewal: { allowed: false, reason: "inactive" } });
        });

        it("FR-034: one 'Cancellation recorded' email", async () => {
            await expect.poll(() => sentTo(u.email).length).toBe(1);
            expect(sentTo(u.email)[0].subject).toBe("Cancellation recorded: Netflix");
            expect(sentTo(u.email)[0].text).toContain(`Cancelled on: ${today}`);
        });

        it("cancelling again is a 409 and sends nothing more", async () => {
            const again = await cancel(u, id);
            expect(again.status).toBe(409);
            await new Promise((r) => setTimeout(r, 50));
            expect(sentTo(u.email)).toHaveLength(1);
        });

        it("it can no longer be renewed (use reactivate)", async () => {
            const res = await api.post(`/api/v1/subscriptions/${id}/renew`).set("Origin", ORIGIN).set("Cookie", u.cookie).set("Idempotency-Key", crypto.randomUUID());
            expect(res.status).toBe(409);
        });
    });

    it("an active subscription: the current cycle stays paid (it was paid up to its date)", async () => {
        const u = await person();
        const due = addDays(today, 10);
        const id = await subscription(u, due);
        expect((await cancel(u, id)).status).toBe(200);
        expect(await ledger(id)).toEqual([`${due}:paid`]);
    });

    it("three clicks at once: one cancellation, two 409s, one email", async () => {
        const u = await person();
        const id = await subscription(u, addDays(today, -1));
        const results = await Promise.all([cancel(u, id), cancel(u, id), cancel(u, id)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        await expect.poll(() => sentTo(u.email).length).toBe(1);
        await new Promise((r) => setTimeout(r, 50));
        expect(sentTo(u.email)).toHaveLength(1);
    });

    it("BR-007: a cancelled subscription is in no digest, neither 'Renews soon' nor 'Needs action'", async () => {
        const u = await person();
        const soon = await subscription(u, addDays(today, 3), "Was-renewing");
        const lapsed = await subscription(u, addDays(today, -1), "Was-lapsed");
        await cancel(u, soon);
        await cancel(u, lapsed);
        await expect.poll(() => sentTo(u.email).length).toBe(2); // the two cancellation emails
        const res = await api.post("/api/v1/internal/jobs/send-reminders").set("X-Internal-Job-Secret", JOB_SECRET);
        expect(res.status).toBe(200);
        expect(sentTo(u.email).filter((m) => !m.subject.startsWith("Cancellation recorded"))).toHaveLength(0);
    });

    describe("SEC-021, SEC-030, SEC-031: who may cancel, and what may be sent", () => {
        let u: Person;
        let id: string;
        beforeAll(async () => {
            u = await person();
            id = await subscription(u, addDays(today, 10));
        });

        it("another user's subscription, an unknown id and a malformed id give the identical 404, and nothing changes", async () => {
            const other = await person();
            const theirs = await cancel(other, id);
            const unknown = await cancel(u, crypto.randomUUID());
            const malformed = await api.post("/api/v1/subscriptions/not-a-uuid/cancel").set("Origin", ORIGIN).set("Cookie", u.cookie);
            expect(theirs.status).toBe(404);
            expect(unknown.body).toEqual(theirs.body);
            expect(malformed.body).toEqual(theirs.body);
            expect((await db.admin.query("SELECT status FROM subscriptions WHERE id = $1", [id])).rows[0].status).toBe("active");
        });

        it("without a session it is a 401; without the app's Origin it is a 403", async () => {
            expect((await api.post(`/api/v1/subscriptions/${id}/cancel`).set("Origin", ORIGIN)).status).toBe(401);
            expect((await api.post(`/api/v1/subscriptions/${id}/cancel`).set("Origin", "https://evil.example").set("Cookie", u.cookie)).status).toBe(403);
        });

        it.each([
            ["a status", { status: "active" }],
            ["a cancellation date", { cancelledOn: "2020-01-01" }],
            ["a user id", { userId: crypto.randomUUID() }],
        ])("a body with %s is a 400 and changes nothing", async (_label, body) => {
            expect((await cancel(u, id, body)).status).toBe(400);
            expect((await db.admin.query("SELECT status, cancelled_on FROM subscriptions WHERE id = $1", [id])).rows[0]).toEqual({ status: "active", cancelled_on: null });
        });
    });

    describe("the database backs it up", () => {
        it("a cancellation date on a subscription that is not inactive is refused", async () => {
            const u = await person();
            const id = await subscription(u, addDays(today, 10));
            await expect(db.admin.query("UPDATE subscriptions SET cancelled_on = current_date WHERE id = $1", [id])).rejects.toThrow(/check constraint/);
        });

        it("the API role cannot set another user's cancellation (no rows reached)", async () => {
            const a = await person();
            const b = await person();
            const bs = await subscription(b, addDays(today, 10));
            const r = await withUserContext(db.app, a.id, (c) => c.query("UPDATE subscriptions SET status = 'inactive', cancelled_on = current_date WHERE id = $1", [bs]));
            expect(r.rowCount).toBe(0);
        });
    });
});
