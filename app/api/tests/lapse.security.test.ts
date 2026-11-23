// Story 5 (a subscription goes unreconciled at renewal) security tests: the lapse rule, the user's
// time zone, the "Needs action" section of the daily digest, and the job role's limits. The clock is
// fixed in 2020 and every due date here is in 2019-2020, so no other test file's data (2026 or
// later) is ever old enough for this job to touch, even when the files run at the same time.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { renewalDigestEmail } from "../src/email/templates.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, buildTestApp, createTestKeys, JOB_SECRET, type TestKeys } from "./helpers.js";

const local = inject("localPg");
const JOB = "/api/v1/internal/jobs/transition-overdue";
const DIGEST = "/api/v1/internal/jobs/send-reminders";

describe("SEC-047: the digest's Needs action section escapes every value", () => {
    it("markup in a name or link arrives as text", () => {
        const { html, subject } = renewalDigestEmail([], [
            { name: "<img src=x onerror=alert(1)>", cost: 5, billingPeriod: "monthly", dueDate: "2020-01-01", daysOverdue: 1, paymentMethodType: "credit_card", renewalLink: "https://e.com/?a=<b>" },
        ]);
        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(html).toContain("https://e.com/?a=&lt;b&gt;");
        expect(subject).toBe("Did it renew? <img src=x onerror=alert(1)>"); // the subject is plain text, never HTML
    });
});

describe("SEC-016: the overdue job is behind the job secret", () => {
    it("without the secret it is a 401 and the job does not run; with it, the job runs", async () => {
        const keys = await createTestKeys();
        const { app, transitionOverdue } = buildTestApp({ keys });
        expect((await supertest(app).post(JOB)).status).toBe(401);
        expect((await supertest(app).post(JOB).set("X-Internal-Job-Secret", "x".repeat(43))).status).toBe(401);
        expect(transitionOverdue.run).not.toHaveBeenCalled();
        const ok = await supertest(app).post(JOB).set("X-Internal-Job-Secret", JOB_SECRET);
        expect(ok.status).toBe(200);
        expect(Object.keys(ok.body).sort()).toEqual(["failed", "subscriptionsLapsed", "usersLapsed"]);
    });
});

describe.skipIf(!local)("Story 5 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let clock = new Date("2020-03-10T12:00:00Z");
    let api: ReturnType<typeof supertest>;
    // Every email the app hands to the (fake) provider, kept for the whole file.
    const outbox: EmailMessage[] = [];

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        api = supertest(buildDbTestApp({ keys, db, now: () => clock, sendEmail: async (m) => void outbox.push(m) }).app);
    });
    afterAll(() => db.close());

    const runJob = (target = api) => target.post(JOB).set("X-Internal-Job-Secret", JOB_SECRET);
    const runDigest = () => api.post(DIGEST).set("X-Internal-Job-Secret", JOB_SECRET);
    const sentTo = (address: string) => outbox.filter((m) => m.to === address);

    async function person(timeZone = "UTC") {
        const user = await createUser(db);
        await db.admin.query("UPDATE profiles SET time_zone = $2 WHERE id = $1", [user.id, timeZone]);
        return { ...user, pm: await addPaymentMethod(db, user.id) };
    }
    // An active recurring subscription whose current cycle is paid and due on the given date.
    async function renewing(owner: { id: string; pm: string }, name: string, dueDate: string, extra: Parameters<typeof addSubscription>[3] = {}) {
        const id = await addSubscription(db, owner.id, owner.pm, { name, ...extra });
        await addBilling(db, owner.id, id, owner.pm, dueDate);
        return id;
    }
    const statusOf = async (id: string) => (await db.admin.query("SELECT status FROM subscriptions WHERE id = $1", [id])).rows[0].status as string;
    const cycles = async (id: string) =>
        (await db.admin.query("SELECT due_date, status FROM billing WHERE subscription_id = $1 ORDER BY due_date", [id])).rows.map(
            (r) => `${r.due_date}:${r.status}`,
        );

    describe("the lapse rule (FR-033, FR-045, BR-006)", () => {
        let u: Awaited<ReturnType<typeof person>>;
        const ids: Record<string, string> = {};

        beforeAll(async () => {
            clock = new Date("2020-03-10T12:00:00Z");
            u = await person("UTC");
            ids.yesterday = await renewing(u, "Due-yesterday", "2020-03-09");
            ids.older = await renewing(u, "Due-last-week", "2020-03-01");
            ids.today = await renewing(u, "Due-today", "2020-03-10");
            ids.oneTime = await renewing(u, "One-time", "2020-03-01", { type: "one_time", period: null });
            ids.inactive = await renewing(u, "Inactive", "2020-03-01");
            await db.admin.query("UPDATE subscriptions SET status = 'inactive' WHERE id = $1", [ids.inactive]);
            // Renewed already: an old paid cycle and a newer one that is not due yet.
            ids.renewed = await renewing(u, "Renewed", "2020-02-09");
            await addBilling(db, u.id, ids.renewed, u.pm, "2020-04-09");
        });

        it("only active recurring subscriptions whose current cycle ended before today lapse", async () => {
            const res = await runJob();
            expect(res.status).toBe(200);
            expect(await statusOf(ids.yesterday)).toBe("active-unknown");
            expect(await statusOf(ids.older)).toBe("active-unknown");
            expect(await statusOf(ids.today)).toBe("active"); // end of the due date has not come yet
            expect(await statusOf(ids.oneTime)).toBe("active");
            expect(await statusOf(ids.inactive)).toBe("inactive");
            expect(await statusOf(ids.renewed)).toBe("active");
        });

        it("the lapsed cycle becomes due and nothing else in the ledger changes", async () => {
            expect(await cycles(ids.yesterday)).toEqual(["2020-03-09:due"]);
            expect(await cycles(ids.renewed)).toEqual(["2020-02-09:paid", "2020-04-09:paid"]);
            expect(await cycles(ids.today)).toEqual(["2020-03-10:paid"]);
        });

        it("a second run changes nothing, and the job itself sends no email", async () => {
            const res = await runJob();
            expect(res.body.subscriptionsLapsed).toBe(0);
            expect(sentTo(u.email)).toHaveLength(0);
            expect(await cycles(ids.yesterday)).toEqual(["2020-03-09:due"]);
        });

        it("the next day, what was due 'today' lapses", async () => {
            clock = new Date("2020-03-11T00:30:00Z");
            await runJob();
            expect(await statusOf(ids.today)).toBe("active-unknown");
        });
    });

    it("three runs at the same moment lapse once", async () => {
        clock = new Date("2020-04-02T12:00:00Z");
        const r = await person("UTC");
        const id = await renewing(r, "Race", "2020-04-01");
        const runs = await Promise.all([runJob(), runJob(), runJob()]);
        expect(runs.reduce((n, res) => n + res.body.subscriptionsLapsed, 0)).toBe(1);
        expect(await statusOf(id)).toBe("active-unknown");
        expect(await cycles(id)).toEqual(["2020-04-01:due"]);
    });

    describe("the user's own midnight decides when the due date has ended", () => {
        it("not yet in Los Angeles at 22:00 on the due date; lapsed at 01:00 the next day", async () => {
            const lena = await person("America/Los_Angeles");
            const id = await renewing(lena, "LA-Plan", "2020-05-01");
            clock = new Date("2020-05-02T05:00:00Z"); // 22:00 on 1 May in Los Angeles, already 2 May in UTC
            await runJob();
            expect(await statusOf(id)).toBe("active");
            clock = new Date("2020-05-02T08:00:00Z"); // 01:00 on 2 May in Los Angeles
            await runJob();
            expect(await statusOf(id)).toBe("active-unknown");
        });

        it("already in Auckland while it is still the due date in UTC", async () => {
            const aroha = await person("Pacific/Auckland");
            const id = await renewing(aroha, "NZ-Plan", "2020-05-10");
            clock = new Date("2020-05-10T13:00:00Z"); // 13:00 on 10 May in UTC, 01:00 on 11 May in Auckland
            await runJob();
            expect(await statusOf(id)).toBe("active-unknown");
        });
    });

    it("SEC-029: each user's lapse touches only their own subscriptions", async () => {
        clock = new Date("2020-06-02T12:00:00Z");
        const anna = await person("UTC");
        const ben = await person("UTC");
        const bens = await renewing(ben, "Ben-Gym", "2020-06-01");
        const bensLater = await renewing(ben, "Ben-Later", "2020-06-20");
        const annas = await renewing(anna, "Anna-Streaming-2", "2020-06-01");
        await runJob();
        expect(await statusOf(annas)).toBe("active-unknown");
        expect(await statusOf(bens)).toBe("active-unknown");
        expect(await statusOf(bensLater)).toBe("active");
    });

    describe("BR-008, FR-053: the Needs action section of the 09:00 digest", () => {
        it("the morning after the renewal date, then every 3 days, while nothing is recorded", async () => {
            const nina = await person("UTC");
            await renewing(nina, "Lapsed-Plan", "2020-11-01");
            clock = new Date("2020-11-02T00:30:00Z");
            await runJob();
            clock = new Date("2020-11-02T08:00:00Z"); // before 09:00: nothing yet
            await runDigest();
            expect(sentTo(nina.email)).toHaveLength(0);

            clock = new Date("2020-11-02T10:00:00Z");
            await runDigest();
            const [first] = sentTo(nina.email);
            expect(first.subject).toBe("Did it renew? Lapsed-Plan");
            expect(first.text).toContain("NEEDS ACTION");
            expect(first.text).toContain("Renewal date: 2020-11-01 (1 day ago)");
            expect(first.text).not.toContain("RENEWS SOON");

            for (const day of ["03", "04"]) {
                clock = new Date(`2020-11-${day}T10:00:00Z`);
                await runDigest();
            }
            expect(sentTo(nina.email)).toHaveLength(1);
            clock = new Date("2020-11-05T10:00:00Z");
            await runDigest();
            expect(sentTo(nina.email)).toHaveLength(2);
            expect(sentTo(nina.email)[1].text).toContain("(4 days ago)");
        });

        it("on any digest day it lists everything that needs action, first, next to what renews soon", async () => {
            const omar = await person("UTC");
            await renewing(omar, "Old-Lapse", "2020-12-01");
            await renewing(omar, "Coming-Up", "2020-12-05");
            clock = new Date("2020-12-02T00:30:00Z");
            await runJob();
            clock = new Date("2020-12-03T10:00:00Z"); // 2 days after the lapse: a day only because Coming-Up is near
            await runDigest();
            const mails = sentTo(omar.email);
            expect(mails).toHaveLength(1);
            expect(mails[0].subject).toBe("1 subscription needs action, 1 renews soon");
            const { text } = mails[0];
            expect(text.indexOf("NEEDS ACTION")).toBeLessThan(text.indexOf("RENEWS SOON"));
            expect(text).toContain("Renewal date: 2020-12-01 (2 days ago)");
            expect(text).toContain("Renews: 2020-12-05 (in 2 days)");
        });

        it("SEC-029, SEC-045: the section holds only the recipient's own subscriptions", async () => {
            const anna = await person("UTC");
            const ben = await person("UTC");
            await renewing(anna, "Anna-Lapsed", "2021-01-01");
            await renewing(ben, "Ben-Lapsed", "2021-01-01");
            clock = new Date("2021-01-02T00:30:00Z");
            await runJob();
            clock = new Date("2021-01-02T10:00:00Z");
            await runDigest();
            const [toAnna] = sentTo(anna.email);
            const [toBen] = sentTo(ben.email);
            expect(toAnna.text).toContain("Anna-Lapsed");
            expect(toAnna.text).not.toContain("Ben-");
            expect(toBen.text).toContain("Ben-Lapsed");
            expect(toBen.text).not.toContain("Anna-");
        });
    });

    describe("least privilege: the job role may make exactly one change", () => {
        // Runs one statement as job_runner inside a transaction that is always rolled back, so
        // nothing here can change data that other tests rely on.
        async function asJob(sql: string): Promise<{ error: string | null; rowCount: number }> {
            const client = await db.job.connect();
            try {
                await client.query("BEGIN");
                const { rowCount } = await client.query(sql);
                return { error: null, rowCount: rowCount ?? 0 };
            } catch (err) {
                return { error: (err as Error).message, rowCount: 0 };
            } finally {
                await client.query("ROLLBACK");
                client.release();
            }
        }
        let lapsed: string;
        let active: string;

        beforeAll(async () => {
            const owner = await person("UTC");
            active = await renewing(owner, "Priv-Active", "2020-10-20");
            lapsed = await renewing(owner, "Priv-Lapsed", "2020-10-01");
            await db.admin.query("UPDATE subscriptions SET status = 'active-unknown' WHERE id = $1", [lapsed]);
            await db.admin.query("UPDATE billing SET status = 'due' WHERE subscription_id = $1", [lapsed]);
        });

        it("active to active-unknown, and paid to due, are allowed", async () => {
            expect(await asJob(`UPDATE subscriptions SET status = 'active-unknown' WHERE id = '${active}'`)).toEqual({ error: null, rowCount: 1 });
            expect(await asJob(`UPDATE billing SET status = 'due' WHERE subscription_id = '${active}'`)).toEqual({ error: null, rowCount: 1 });
        });

        it.each([
            ["cancel a subscription", (a: string) => `UPDATE subscriptions SET status = 'inactive' WHERE id = '${a}'`],
            ["set an active subscription to active", (a: string) => `UPDATE subscriptions SET status = 'active' WHERE id = '${a}'`],
        ])("cannot %s (row-level policy)", async (_name, sql) => {
            expect((await asJob(sql(active))).error).toMatch(/row-level security/);
        });

        it("cannot reactivate a lapsed subscription or mark a due cycle paid again: those rows are out of reach", async () => {
            expect(await asJob(`UPDATE subscriptions SET status = 'active' WHERE id = '${lapsed}'`)).toEqual({ error: null, rowCount: 0 });
            expect(await asJob(`UPDATE billing SET status = 'paid' WHERE subscription_id = '${lapsed}'`)).toEqual({ error: null, rowCount: 0 });
        });

        it.each([
            "UPDATE subscriptions SET name = 'x'",
            "UPDATE subscriptions SET price = 1",
            "UPDATE subscriptions SET user_id = gen_random_uuid()",
            "UPDATE billing SET amount = 1",
            "UPDATE billing SET due_date = '2000-01-01'",
            "DELETE FROM subscriptions",
            "DELETE FROM billing",
            "INSERT INTO billing (amount, due_date, created_by) VALUES (1, '2020-01-01', 'system')",
        ])("is refused: %s", async (sql) => {
            expect((await asJob(sql)).error).toMatch(/permission denied/);
        });
    });
});
