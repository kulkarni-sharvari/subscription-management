// Story 10 (monthly summary email) security tests: when it is sent, to whom, what it contains, the
// opt-out switch and the signed one-click unsubscribe link. Job tests fix the clock in 2031 so no
// other test file's data is in the summarised month.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { isValidUnsubscribeToken, unsubscribeToken } from "../src/domain/unsubscribeToken.js";
import { monthlySummaryEmail } from "../src/email/templates.js";
import { previousMonth } from "../src/jobs/sendMonthlySummary.js";
import type { SpendingReport } from "../src/repositories/analyticsRepository.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, buildTestApp, createTestKeys, EMAIL_LINK_SECRET, JOB_SECRET, NO_LIMITS, ORIGIN, sessionCookie, type TestKeys } from "./helpers.js";

const local = inject("localPg");
const JOB = "/api/v1/internal/jobs/send-monthly-summary";
const UNSUBSCRIBE = "/api/v1/email/unsubscribe";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";

describe("the month summarised", () => {
    it.each([
        ["2031-07-01", { from: "2031-06-01", to: "2031-06-30", key: "2031-06", name: "June 2031" }],
        ["2032-03-01", { from: "2032-02-01", to: "2032-02-29", key: "2032-02", name: "February 2032" }],
        ["2031-01-01", { from: "2030-12-01", to: "2030-12-31", key: "2030-12", name: "December 2030" }],
    ])("on %s it is the month before, every day of it", (date, expected) => {
        expect(previousMonth(date)).toEqual(expected);
    });
});

describe("the unsubscribe signature", () => {
    it("is valid only for the user it was made for, with the same secret", () => {
        const token = unsubscribeToken(EMAIL_LINK_SECRET, A);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(isValidUnsubscribeToken(EMAIL_LINK_SECRET, A, token)).toBe(true);
        expect(isValidUnsubscribeToken(EMAIL_LINK_SECRET, B, token)).toBe(false);
        expect(isValidUnsubscribeToken("another-secret-0123456789abcdefghijklmnopqr", A, token)).toBe(false);
        expect(isValidUnsubscribeToken(EMAIL_LINK_SECRET, A, token.slice(0, -1))).toBe(false);
        expect(isValidUnsubscribeToken(EMAIL_LINK_SECRET, A, "")).toBe(false);
    });
});

describe("SEC-047: the summary escapes every value", () => {
    const EVIL = "<img src=x onerror=alert(1)>";
    const report: SpendingReport = {
        range: { from: "2031-06-01", to: "2031-06-30" },
        paid: { total: 10, payments: 1, byCategory: [], byMonth: [], recurring: { total: 10, payments: 1 }, oneTime: { total: 0, payments: 0 } },
        monthlyCost: { total: 10, subscriptions: 1, byCategory: [{ category: EVIL, monthly: 10 }] },
        statusCounts: { active: 1, activeUnknown: 1, inactive: 0 },
        pendingReconciliation: [{ id: A, name: `${EVIL}"'`, category: EVIL, renewalDate: "2031-06-20", monthlyCost: 5 }],
    };

    it("markup in a category, a name or a link arrives as text", () => {
        const { html, subject, text } = monthlySummaryEmail(report, "June 2031", {
            spending: "http://localhost:3000/analytics",
            unsubscribe: 'http://localhost:3000/unsubscribe?u=1&t="><script>1</script>',
        });
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain("&lt;img");
        expect(subject).toBe("Your subscriptions in June 2031");
        expect(text).toContain("Needs action (not in the monthly cost)".toUpperCase());
    });
});

describe("the job endpoint, the setting and the unsubscribe link (HTTP)", () => {
    let keys: TestKeys;
    beforeAll(async () => {
        keys = await createTestKeys();
    });

    it("SEC-016: the job runs only with the shared secret", async () => {
        const { app, sendMonthlySummary } = buildTestApp({ keys });
        expect((await supertest(app).post(JOB)).status).toBe(401);
        expect((await supertest(app).post(JOB).set("X-Internal-Job-Secret", "wrong")).status).toBe(401);
        expect(sendMonthlySummary.run).not.toHaveBeenCalled();
        const res = await supertest(app).post(JOB).set("X-Internal-Job-Secret", JOB_SECRET);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(["alreadySent", "capped", "failed", "nothingToReport", "sent", "usersDue"]);
    });

    const patch = async (app: Parameters<typeof supertest>[0], body: unknown) =>
        supertest(app)
            .patch("/api/v1/me")
            .set("Origin", ORIGIN)
            .set("Cookie", await sessionCookie(keys, A))
            .set("Content-Type", "application/json")
            .send(JSON.stringify(body));

    it("PATCH /me turns the monthly summary off and on", async () => {
        const { app, updateProfile } = buildTestApp({ keys });
        const res = await patch(app, { monthlySummary: false });
        expect(res.status).toBe(200);
        expect(res.body.monthlySummary).toBe(false);
        expect(updateProfile).toHaveBeenCalledWith(A, { monthlySummary: false });
    });

    it.each([{ monthlySummary: "false" }, { monthlySummary: 0 }, { monthlySummary: null }, { monthlySummary: false, email: "x@example.com" }, {}])(
        "SEC-030: PATCH /me rejects %j with 400",
        async (body) => {
            const { app, updateProfile } = buildTestApp({ keys });
            expect((await patch(app, body)).status).toBe(400);
            expect(updateProfile).not.toHaveBeenCalled();
        },
    );

    const link = (userId: string, token = unsubscribeToken(EMAIL_LINK_SECRET, userId)) => `${UNSUBSCRIBE}?u=${userId}&t=${token}`;

    it("a signed link turns it off with no session and no Origin, as a mail app's one-click POST does", async () => {
        const { app, updateProfile } = buildTestApp({ keys });
        const res = await supertest(app).post(link(A)).type("form").send("List-Unsubscribe=One-Click");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ unsubscribed: true });
        expect(updateProfile).toHaveBeenCalledWith(A, { monthlySummary: false });
    });

    it.each([
        ["another user's signature", () => link(B, unsubscribeToken(EMAIL_LINK_SECRET, A))],
        ["a signature made with another secret", () => link(A, unsubscribeToken("another-secret-0123456789abcdefghijklmnopqr", A))],
        ["a shortened signature", () => link(A, unsubscribeToken(EMAIL_LINK_SECRET, A).slice(0, -1))],
        ["no signature", () => `${UNSUBSCRIBE}?u=${A}`],
        ["a malformed user id", () => `${UNSUBSCRIBE}?u=not-a-uuid&t=${unsubscribeToken(EMAIL_LINK_SECRET, "not-a-uuid")}`],
        ["an extra parameter", () => `${link(A)}&monthlySummary=true`],
    ])("%s is a 400 and changes nothing", async (_label, url) => {
        const { app, updateProfile } = buildTestApp({ keys });
        const res = await supertest(app).post(url());
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe("This unsubscribe link is not valid");
        expect(updateProfile).not.toHaveBeenCalled();
    });

    it("a GET (a mail scanner opening the link) changes nothing", async () => {
        const { app, updateProfile } = buildTestApp({ keys });
        // Not answered by the unsubscribe route; it falls through to the signed-in API, which refuses it.
        expect((await supertest(app).get(link(A))).status).toBe(401);
        expect(updateProfile).not.toHaveBeenCalled();
    });

    it("SEC-051: bad links are rate limited per address; valid one-click requests never are", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const { app } = buildTestApp({ keys, limits: { ...NO_LIMITS, emailLinks: { limit: 2, windowMs: 60_000 } } });
        const api = supertest(app);
        // A mail provider unsubscribing many users from one address.
        for (let i = 0; i < 5; i++) expect((await api.post(link(A))).status).toBe(200);
        expect((await api.post(link(B, "x".repeat(43)))).status).toBe(400);
        expect((await api.post(link(B, "y".repeat(43)))).status).toBe(400);
        expect((await api.post(link(B, "z".repeat(43)))).status).toBe(429);
        // Once blocked, the address waits out the window.
        expect((await api.post(link(A))).status).toBe(429);
        warn.mockRestore();
        info.mockRestore();
    });

    it("SEC-049: each unsubscribe is logged with its request and user; a rejected one with its address; never the signature", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const { app } = buildTestApp({ keys });
        const token = unsubscribeToken(EMAIL_LINK_SECRET, A);
        await supertest(app).post(link(A));
        await supertest(app).post(link(B, token));
        expect(info).toHaveBeenCalledWith("monthly summary unsubscribed", { requestId: expect.any(String), userId: A });
        expect(warn).toHaveBeenCalledWith("unsubscribe link rejected", { requestId: expect.any(String), ip: expect.any(String) });
        expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain(token);
        warn.mockRestore();
        info.mockRestore();
    });
});

describe.skipIf(!local)("Story 10 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let clock = new Date("2031-07-01T09:00:00Z");
    let failFor: string | null = null;
    let api: ReturnType<typeof supertest>;
    const outbox: EmailMessage[] = [];

    beforeAll(async () => {
        db = connect(local!);
        keys = await createTestKeys();
        const built = buildDbTestApp({
            keys,
            db,
            now: () => clock,
            sendEmail: async (m) => {
                if (m.to === failFor) throw new Error("provider down");
                outbox.push(m);
            },
        });
        api = supertest(built.app);
    });
    afterAll(() => db.close());

    const runJob = async () => (await api.post(JOB).set("X-Internal-Job-Secret", JOB_SECRET)).body;
    const sentTo = (address: string) => outbox.filter((m) => m.to === address);

    // A user in the given zone with one subscription paid in June 2031 (paid_on is a month before the due date).
    async function person(timeZone = "UTC", name = "Netflix") {
        const user = await createUser(db);
        await db.admin.query("UPDATE profiles SET time_zone = $2 WHERE id = $1", [user.id, timeZone]);
        const pm = await addPaymentMethod(db, user.id);
        const sub = await addSubscription(db, user.id, pm, { name, category: `Cat-${name}` });
        await addBilling(db, user.id, sub, pm, "2031-07-10");
        return { ...user, pm, sub };
    }
    const optedIn = async (userId: string) => (await db.admin.query("SELECT monthly_summary FROM profiles WHERE id = $1", [userId])).rows[0].monthly_summary;

    it("FR-052: one email on the 1st from 09:00, about last month, with the one-click unsubscribe headers", async () => {
        clock = new Date("2031-07-01T08:00:00Z");
        const u = await person("UTC", "Paid-in-June");
        await runJob();
        expect(sentTo(u.email)).toHaveLength(0); // not yet 09:00

        clock = new Date("2031-07-01T09:00:00Z");
        await runJob();
        const [mail] = sentTo(u.email);
        expect(sentTo(u.email)).toHaveLength(1);
        expect(mail.subject).toBe("Your subscriptions in June 2031");
        expect(mail.text).toContain("Total: 15.49 (1 payment)");
        expect(mail.text).toContain("Cat-Paid-in-June: 15.49");

        const token = unsubscribeToken(EMAIL_LINK_SECRET, u.id);
        expect(mail.headers).toEqual({
            "List-Unsubscribe": `<${ORIGIN}/api/v1/email/unsubscribe?u=${u.id}&t=${token}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        });
        expect(mail.text).toContain(`${ORIGIN}/unsubscribe?u=${u.id}&t=${token}`);
        // The provider delivers a retry of this month's summary only once.
        expect(mail.idempotencyKey).toBe(`monthly-summary/${u.id}/2031-06`);

        // FR-051: a later run, or a retry, sends nothing more this month.
        clock = new Date("2031-07-01T15:00:00Z");
        await runJob();
        expect(sentTo(u.email)).toHaveLength(1);
    });

    it("SEC-045: each email carries only its owner's data", async () => {
        clock = new Date("2031-08-01T09:30:00Z");
        const a = await person("UTC", "Only-A");
        const b = await person("UTC", "Only-B");
        await runJob();
        expect(sentTo(a.email)[0].text).not.toContain("Only-B");
        expect(sentTo(b.email)[0].text).not.toContain("Only-A");
    });

    it("the 1st is the user's own: Auckland's arrives while it is still June 30 in UTC; Los Angeles waits", async () => {
        clock = new Date("2031-09-30T21:00:00Z"); // 09:00 on 1 October in Auckland, 14:00 on 30 September in LA
        const nz = await person("Pacific/Auckland", "NZ");
        const la = await person("America/Los_Angeles", "LA");
        await runJob();
        expect(sentTo(nz.email)).toHaveLength(1);
        expect(sentTo(la.email)).toHaveLength(0);

        clock = new Date("2031-10-01T16:00:00Z"); // 09:00 on 1 October in LA
        await runJob();
        expect(sentTo(la.email)).toHaveLength(1);
    });

    it("on any other day nothing is read or sent", async () => {
        clock = new Date("2031-10-15T12:00:00Z");
        expect(await runJob()).toEqual({ usersDue: 0, sent: 0, alreadySent: 0, nothingToReport: 0, capped: 0, failed: 0 });
    });

    it("a user with no subscriptions and no payments gets nothing", async () => {
        clock = new Date("2031-11-01T09:00:00Z");
        const empty = await createUser(db);
        await runJob();
        expect(sentTo(empty.email)).toHaveLength(0);
    });

    it("a failed send is retried by a later run, and sent once", async () => {
        clock = new Date("2031-12-01T09:00:00Z");
        const u = await person("UTC", "Retry");
        failFor = u.email;
        await runJob();
        expect(sentTo(u.email)).toHaveLength(0);
        failFor = null;
        clock = new Date("2031-12-01T10:00:00Z");
        await runJob();
        expect(sentTo(u.email)).toHaveLength(1);
    });

    it("the unsubscribe link turns it off for that user only, and next month nothing is sent", async () => {
        const u = await person("UTC", "Unsub");
        const other = await person("UTC", "Stays");
        const res = await api.post(`${UNSUBSCRIBE}?u=${u.id}&t=${unsubscribeToken(EMAIL_LINK_SECRET, u.id)}`);
        expect(res.status).toBe(200);
        expect(await optedIn(u.id)).toBe(false);
        expect(await optedIn(other.id)).toBe(true);

        clock = new Date("2032-01-01T09:00:00Z");
        await runJob();
        expect(sentTo(u.email)).toHaveLength(0);
        expect(sentTo(other.email)).toHaveLength(1);
    });

    it("the settings switch turns it back on, only for the signed-in user", async () => {
        const u = await person();
        await db.admin.query("UPDATE profiles SET monthly_summary = false WHERE id = $1", [u.id]);
        const res = await api
            .patch("/api/v1/me")
            .set("Origin", ORIGIN)
            .set("Cookie", await sessionCookie(keys, u.id))
            .send({ monthlySummary: true });
        expect(res.status).toBe(200);
        expect(res.body.monthlySummary).toBe(true);
        expect(await optedIn(u.id)).toBe(true);
    });

    it("least privilege: the job role cannot change anyone's choice; the API role cannot change another user's", async () => {
        const u = await person();
        await expect(db.job.query("UPDATE profiles SET monthly_summary = false WHERE id = $1", [u.id])).rejects.toThrow(/permission denied/);
        const other = await person();
        const { withUserContext } = await import("../src/db/pool.js");
        const changed = await withUserContext(db.app, u.id, (c) => c.query("UPDATE profiles SET monthly_summary = false WHERE id = $1", [other.id]));
        expect(changed.rowCount).toBe(0);
        expect(await optedIn(other.id)).toBe(true);
    });
});
