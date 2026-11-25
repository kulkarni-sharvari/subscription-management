// Story 4 (renewal reminder digest) security tests: the job secret, the job role's limits, the
// digest rules, retries, the daily email cap and the user's time zone. Names start with the
// requirement they verify. Job tests fix the clock in 2031 so no other test file's data is in range.
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { withUserContext } from "../src/db/pool.js";
import { addDays, daysBetween } from "../src/domain/billingDates.js";
import { isValidTimeZone, localDateAndHour } from "../src/domain/timeZones.js";
import { renewalDigestEmail } from "../src/email/templates.js";
import { reserveEmailSlot } from "../src/repositories/notificationLogRepository.js";
import type { EmailMessage } from "../src/services/emailService.js";
import { EMAIL_DAILY_CAP } from "../src/services/notificationService.js";
import { addBilling, addPaymentMethod, addSubscription, connect, createUser, type Db } from "./dbHelpers.js";
import { buildDbTestApp, buildTestApp, createTestKeys, JOB_SECRET, NO_LIMITS, ORIGIN, sessionCookie, signToken, type TestKeys } from "./helpers.js";

const local = inject("localPg");
const JOB = "/api/v1/internal/jobs/send-reminders";

describe("calendar and time-zone helpers", () => {
    it("counts whole calendar days, across month, year and leap-day boundaries", () => {
        expect(daysBetween("2031-06-10", "2031-06-15")).toBe(5);
        expect(daysBetween("2031-06-10", "2031-06-10")).toBe(0);
        expect(daysBetween("2031-06-10", "2031-06-09")).toBe(-1);
        expect(daysBetween("2031-12-30", "2032-01-02")).toBe(3);
        expect(addDays("2032-02-28", 1)).toBe("2032-02-29");
        expect(addDays("2031-02-28", 1)).toBe("2031-03-01");
    });

    it("a daylight-saving change does not make a day longer or shorter", () => {
        // US clocks change on 9 March 2031 and 2 November 2031.
        expect(daysBetween("2031-03-08", "2031-03-10")).toBe(2);
        expect(daysBetween("2031-11-01", "2031-11-03")).toBe(2);
    });

    it.each(["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "America/Argentina/Buenos_Aires", "Etc/GMT+5"])(
        "accepts the real zone %s",
        (zone) => expect(isValidTimeZone(zone)).toBe(true),
    );

    it.each(["", "Mars/Olympus_Mons", "../../etc/passwd", "UTC; DROP TABLE profiles", "America/New York", "x".repeat(65), "<script>", "Europe/../Asia"])(
        "rejects %j",
        (zone) => expect(isValidTimeZone(zone)).toBe(false),
    );

    it("works out the user's own date and hour", () => {
        const moment = new Date("2031-06-10T22:30:00Z");
        expect(localDateAndHour(moment, "UTC")).toEqual({ date: "2031-06-10", hour: 22 });
        expect(localDateAndHour(moment, "Pacific/Auckland")).toEqual({ date: "2031-06-11", hour: 10 });
        expect(localDateAndHour(moment, "America/Los_Angeles")).toEqual({ date: "2031-06-10", hour: 15 });
    });
});

describe("SEC-047: the digest escapes every value", () => {
    it("markup in a name or link arrives as text", () => {
        const { html, subject } = renewalDigestEmail([
            {
                name: "<img src=x onerror=alert(1)>",
                cost: 9.99,
                billingPeriod: "monthly",
                dueDate: "2031-06-11",
                daysLeft: 1,
                paymentMethodType: "credit_card",
                renewalLink: 'https://example.com/"><script>1</script>',
            },
        ]);
        expect(html).not.toMatch(/<img|<script/);
        expect(html).toContain("&lt;img");
        expect(subject).not.toMatch(/[\r\n]/);
        expect(subject).toContain("tomorrow");
    });
});

describe("SEC-016: only the shared secret opens the job endpoints", () => {
    let keys: TestKeys;
    beforeAll(async () => {
        keys = await createTestKeys();
    });

    it("the correct secret runs the job and returns counts only; no Origin or cookie is needed", async () => {
        const { app, sendReminders } = buildTestApp({ keys });
        const res = await supertest(app).post(JOB).set("X-Internal-Job-Secret", JOB_SECRET);
        expect(res.status).toBe(200);
        expect(sendReminders.run).toHaveBeenCalledTimes(1);
        expect(Object.keys(res.body).sort()).toEqual(["alreadySent", "capped", "failed", "notYetMorning", "sent", "usersDue"]);
    });

    it.each([
        ["no secret", undefined],
        ["an empty secret", ""],
        ["a wrong secret", "wrong"],
        ["the secret with one character changed", JOB_SECRET.slice(0, -1) + "X"],
        ["the secret with extra characters", JOB_SECRET + "x"],
        ["the secret in a different case", JOB_SECRET.toUpperCase()],
    ])("%s returns 401 and the job does not run", async (_label, secret) => {
        const { app, sendReminders } = buildTestApp({ keys });
        const req = supertest(app).post(JOB);
        const res = await (secret === undefined ? req : req.set("X-Internal-Job-Secret", secret));
        expect(res.status).toBe(401);
        expect(sendReminders.run).not.toHaveBeenCalled();
    });

    it("a valid user session is not a way in", async () => {
        const { app, sendReminders } = buildTestApp({ keys });
        const token = await signToken(keys.privateKey);
        const res = await supertest(app).post(JOB).set("Origin", ORIGIN).set("Cookie", `sm_access=${token}`);
        expect(res.status).toBe(401);
        expect(sendReminders.run).not.toHaveBeenCalled();
    });

    it("the secret in the query string or the body is ignored", async () => {
        const { app, sendReminders } = buildTestApp({ keys });
        expect((await supertest(app).post(`${JOB}?secret=${JOB_SECRET}`)).status).toBe(401);
        expect((await supertest(app).post(JOB).send({ "X-Internal-Job-Secret": JOB_SECRET })).status).toBe(401);
        expect(sendReminders.run).not.toHaveBeenCalled();
    });

    it("the job secret does not open user routes", async () => {
        const { app } = buildTestApp({ keys });
        const res = await supertest(app).get("/api/v1/subscriptions?status=active").set("X-Internal-Job-Secret", JOB_SECRET);
        expect(res.status).toBe(401);
    });

    it("an unknown job or a GET is a 404 with the secret, and still a 401 without it", async () => {
        const { app } = buildTestApp({ keys });
        expect((await supertest(app).post("/api/v1/internal/jobs/drop-everything").set("X-Internal-Job-Secret", JOB_SECRET)).status).toBe(404);
        expect((await supertest(app).get(JOB).set("X-Internal-Job-Secret", JOB_SECRET)).status).toBe(404);
        expect((await supertest(app).post("/api/v1/internal/jobs/drop-everything")).status).toBe(401);
    });

    it("SEC-049: a rejected attempt is logged with where it came from, never the value sent", async () => {
        const { app } = buildTestApp({ keys });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await supertest(app).post(JOB).set("X-Internal-Job-Secret", "guess-number-one");
        expect(warn).toHaveBeenCalledWith("internal job request rejected", expect.objectContaining({ path: JOB }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain("guess-number-one");
        warn.mockRestore();
    });

    it("wrong secrets are rate limited per address; correct calls are not counted", async () => {
        const limits = { ...NO_LIMITS, jobAuthFailures: { limit: 3, windowMs: 60_000 } };
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const good = supertest(buildTestApp({ keys, limits }).app);
        for (let i = 0; i < 6; i++) expect((await good.post(JOB).set("X-Internal-Job-Secret", JOB_SECRET)).status).toBe(200);

        const { app, sendReminders } = buildTestApp({ keys, limits });
        const api = supertest(app);
        for (let i = 0; i < 3; i++) expect((await api.post(JOB).set("X-Internal-Job-Secret", `guess-${i}`)).status).toBe(401);
        expect((await api.post(JOB).set("X-Internal-Job-Secret", "guess-4")).status).toBe(429);
        // Once blocked, even the right secret waits out the window, so guessing cannot continue.
        expect((await api.post(JOB).set("X-Internal-Job-Secret", JOB_SECRET)).status).toBe(429);
        expect(sendReminders.run).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("PATCH /me: the user's time zone", () => {
    let keys: TestKeys;
    beforeAll(async () => {
        keys = await createTestKeys();
    });
    const patch = async (app: Parameters<typeof supertest>[0], body: unknown, origin = ORIGIN) =>
        supertest(app)
            .patch("/api/v1/me")
            .set("Origin", origin)
            .set("Cookie", `sm_access=${await signToken(keys.privateKey)}`)
            .set("Content-Type", "application/json")
            .send(JSON.stringify(body));

    it("stores a real zone", async () => {
        const { app, updateProfile } = buildTestApp({ keys });
        const res = await patch(app, { timeZone: "Asia/Kolkata" });
        expect(res.status).toBe(200);
        expect(res.body.timeZone).toBe("Asia/Kolkata");
        expect(updateProfile).toHaveBeenCalledWith(expect.any(String), { timeZone: "Asia/Kolkata" });
    });

    it.each([
        { timeZone: "Mars/Olympus_Mons" },
        { timeZone: "../../etc/passwd" },
        { timeZone: "UTC'; DROP TABLE profiles;--" },
        { timeZone: "x".repeat(200) },
        { timeZone: "" },
        { timeZone: 5 },
        { timeZone: null },
        {},
        { timeZone: "UTC", email: "attacker@example.com" },
        { timeZone: "UTC", id: "someone-else" },
        "UTC",
    ])("SEC-030: rejects %j with 400 and stores nothing", async (body) => {
        const { app, updateProfile } = buildTestApp({ keys });
        expect((await patch(app, body)).status).toBe(400);
        expect(updateProfile).not.toHaveBeenCalled();
    });

    it("SEC-021: needs the same-origin check and a session", async () => {
        const { app, updateProfile } = buildTestApp({ keys });
        expect((await patch(app, { timeZone: "UTC" }, "https://evil.example")).status).toBe(403);
        const anonymous = await supertest(app).patch("/api/v1/me").set("Origin", ORIGIN).send({ timeZone: "UTC" });
        expect(anonymous.status).toBe(401);
        expect(updateProfile).not.toHaveBeenCalled();
    });
});

describe.skipIf(!local)("Story 4 against the database", () => {
    let db: Db;
    let keys: TestKeys;
    let clock = new Date("2031-06-10T15:00:00Z");
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
    const sentTo = (address: string) => outbox.filter((m) => m.to === address);

    // A user in the given zone, with one payment method.
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
    const logRows = async (userId: string) =>
        Number((await db.admin.query("SELECT count(*) AS n FROM notification_log WHERE user_id = $1", [userId])).rows[0].n);
    const slotsUsed = async (userId: string) =>
        Number((await db.admin.query("SELECT COALESCE(SUM(sent), 0) AS n FROM email_daily_count WHERE user_id = $1", [userId])).rows[0].n);

    describe("the digest (FR-050, BR-007)", () => {
        let u: Awaited<ReturnType<typeof person>>;

        beforeAll(async () => {
            clock = new Date("2031-06-10T15:00:00Z");
            u = await person("UTC");
            await renewing(u, "Due-today", "2031-06-10");
            await renewing(u, "In-1", "2031-06-11");
            await renewing(u, "In-3", "2031-06-13");
            await renewing(u, "In-5", "2031-06-15");
            await renewing(u, "In-6", "2031-06-16");
            await renewing(u, "One-time", "2031-06-12", { type: "one_time", period: null });
            const gone = await renewing(u, "Inactive", "2031-06-12");
            await db.admin.query("UPDATE subscriptions SET status = 'inactive' WHERE id = $1", [gone]);
            const unknown = await renewing(u, "Unknown", "2031-06-12");
            await db.admin.query("UPDATE subscriptions SET status = 'active-unknown' WHERE id = $1", [unknown]);
            await db.admin.query("UPDATE billing SET status = 'due' WHERE subscription_id = $1", [unknown]);
        });

        it("sends one email listing only the active recurring subscriptions 1 to 5 days away", async () => {
            expect((await runJob()).status).toBe(200);
            const mails = sentTo(u.email);
            expect(mails).toHaveLength(1);
            const { subject, text } = mails[0];
            expect(subject).toBe("3 subscriptions renew soon");
            for (const name of ["In-1", "In-3", "In-5"]) expect(text).toContain(`Name: ${name}`);
            for (const name of ["Due-today", "In-6", "One-time", "Inactive", "Unknown"]) expect(text).not.toContain(`Name: ${name}`);
            expect(text).toContain("2031-06-11 (tomorrow)");
            expect(text).toContain("2031-06-13 (in 3 days)");
        });

        it("FR-051: a second run the same day sends nothing more", async () => {
            const res = await runJob();
            expect(res.body.alreadySent).toBeGreaterThanOrEqual(1);
            expect(sentTo(u.email)).toHaveLength(1);
            expect(await logRows(u.id)).toBe(1);
        });

        it("two runs at the same moment still send only once", async () => {
            clock = new Date("2031-06-11T15:00:00Z");
            await Promise.all([runJob(), runJob(), runJob()]);
            expect(sentTo(u.email)).toHaveLength(2);
        });

        it("the next day's digest counts down: what renewed today drops out, what is now 5 days away joins", async () => {
            const { text } = sentTo(u.email)[1];
            expect(text).not.toContain("Name: In-1");
            expect(text).toContain("2031-06-13 (in 2 days)");
            expect(text).toContain("Name: In-6");
        });

        it("a user with nothing due gets no email and no log row", async () => {
            const quiet = await person("UTC");
            await renewing(quiet, "Far-away", "2031-07-30");
            await runJob();
            expect(sentTo(quiet.email)).toHaveLength(0);
            expect(await logRows(quiet.id)).toBe(0);
        });
    });

    it("SEC-029, SEC-045: each email goes to one person and holds only that person's subscriptions", async () => {
        clock = new Date("2031-06-20T12:00:00Z");
        const anna = await person("UTC");
        const ben = await person("UTC");
        await renewing(anna, "Anna-Streaming", "2031-06-22");
        await renewing(ben, "Ben-Gym", "2031-06-23");
        await runJob();
        const [toAnna] = sentTo(anna.email);
        const [toBen] = sentTo(ben.email);
        expect(toAnna.text).toContain("Anna-Streaming");
        expect(toAnna.text).not.toContain("Ben-Gym");
        expect(toBen.text).toContain("Ben-Gym");
        expect(toBen.text).not.toContain("Anna-Streaming");
        expect(typeof toAnna.to).toBe("string");
    });

    describe("the user's own time zone decides the day and the hour", () => {
        it("nothing is sent before 09:00 where the user is; the first run after it sends", async () => {
            const lena = await person("America/Los_Angeles");
            await renewing(lena, "LA-Plan", "2031-07-02");
            clock = new Date("2031-07-01T15:00:00Z"); // 08:00 in Los Angeles
            const early = await runJob();
            expect(early.body.notYetMorning).toBeGreaterThanOrEqual(1);
            expect(sentTo(lena.email)).toHaveLength(0);
            clock = new Date("2031-07-01T17:00:00Z"); // 10:00 in Los Angeles
            await runJob();
            expect(sentTo(lena.email)).toHaveLength(1);
        });

        it("days are counted in the user's calendar, not UTC's", async () => {
            const aroha = await person("Pacific/Auckland");
            await renewing(aroha, "NZ-Plan", "2031-07-12");
            clock = new Date("2031-07-10T22:00:00Z"); // 10 July in UTC, already 10:00 on 11 July in Auckland
            await runJob();
            const [mail] = sentTo(aroha.email);
            expect(mail.text).toContain("2031-07-12 (tomorrow)");
        });
    });

    it("NFR-041: a failed send records nothing and uses no allowance, so the next run sends it", async () => {
        clock = new Date("2031-08-01T12:00:00Z");
        const fay = await person("UTC");
        await renewing(fay, "Retry-Me", "2031-08-03");
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const broken = supertest(
            buildDbTestApp({ keys, db, now: () => clock, sendEmail: async () => { throw new Error("email provider rejected the message (internal_server_error)"); } }).app,
        );
        const failed = await runJob(broken);
        expect(failed.body.failed).toBeGreaterThanOrEqual(1);
        expect(await logRows(fay.id)).toBe(0);
        expect(await slotsUsed(fay.id)).toBe(0);
        expect(JSON.stringify(errors.mock.calls)).not.toContain(fay.email);
        errors.mockRestore();

        await runJob();
        expect(sentTo(fay.email)).toHaveLength(1);
        expect(await logRows(fay.id)).toBe(1);
    });

    describe("SEC-048: the daily email cap", () => {
        const today = async () => (await db.admin.query("SELECT (now() AT TIME ZONE 'UTC')::date AS d")).rows[0].d as string;
        const preset = async (userId: string, sent: number) =>
            db.admin.query("INSERT INTO email_daily_count (user_id, day, sent) VALUES ($1, $2, $3)", [userId, await today(), sent]);

        it("a user at the cap gets no digest, and nothing is recorded, so it can go out once the cap resets", async () => {
            clock = new Date("2031-08-10T12:00:00Z");
            const carl = await person("UTC");
            await renewing(carl, "Capped", "2031-08-12");
            await preset(carl.id, EMAIL_DAILY_CAP);
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const res = await runJob();
            expect(res.body.capped).toBeGreaterThanOrEqual(1);
            expect(sentTo(carl.email)).toHaveLength(0);
            expect(await logRows(carl.id)).toBe(0);
            warn.mockRestore();
        });

        it("a user at the cap gets no 'subscription added' email either", async () => {
            const dora = await person("UTC");
            await preset(dora.id, EMAIL_DAILY_CAP);
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const res = await api
                .post("/api/v1/subscriptions")
                .set("Origin", ORIGIN)
                .set("Cookie", await sessionCookie(keys, dora.id))
                .send({ name: "Over-cap", category: "Test", subscriptionType: "recurring", billingPeriod: "monthly", startDate: "2026-09-08", cost: 5, paymentMethodId: dora.pm, autoRenews: false });
            expect(res.status).toBe(201);
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("email not sent: daily cap reached", expect.objectContaining({ userId: dora.id })));
            expect(sentTo(dora.email)).toHaveLength(0);
            warn.mockRestore();
        });

        it("five sends racing for the last slot: exactly one gets it", async () => {
            const eve = await person("UTC");
            await preset(eve.id, EMAIL_DAILY_CAP - 1);
            const results = await Promise.all(
                Array.from({ length: 5 }, () => withUserContext(db.app, eve.id, (c) => reserveEmailSlot(c, eve.id, EMAIL_DAILY_CAP))),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await slotsUsed(eve.id)).toBe(EMAIL_DAILY_CAP);
        });

        it("a warning is logged when the whole app reaches 80% of the provider's daily limit", async () => {
            const bulk = await person("UTC");
            await preset(bulk.id, 80);
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            await runJob();
            expect(warn).toHaveBeenCalledWith("email volume near the provider's daily limit", expect.objectContaining({ limit: 100 }));
            warn.mockRestore();
        });
    });

    it("the time zone is saved for the caller only, and the email cannot be changed this way", async () => {
        const zara = await person("UTC");
        const other = await person("UTC");
        const cookie = await sessionCookie(keys, zara.id);
        const res = await api.patch("/api/v1/me").set("Origin", ORIGIN).set("Cookie", cookie).send({ timeZone: "Europe/Berlin" });
        expect(res.status).toBe(200);
        expect((await api.get("/api/v1/me").set("Cookie", cookie)).body).toMatchObject({ email: zara.email, timeZone: "Europe/Berlin" });
        const rows = (await db.admin.query("SELECT id, email, time_zone FROM profiles WHERE id = ANY($1)", [[zara.id, other.id]])).rows;
        expect(rows.find((r) => r.id === other.id).time_zone).toBe("UTC");
        expect(rows.find((r) => r.id === zara.id).email).toBe(zara.email);
    });

    describe("least privilege: what each role can and cannot do", () => {
        const jobError = async (sql: string, params: unknown[] = []) => {
            try {
                await db.job.query(sql, params);
                return null;
            } catch (err) {
                return (err as Error).message;
            }
        };
        const appError = async (userId: string, sql: string, params: unknown[] = []) => {
            try {
                await withUserContext(db.app, userId, (c) => c.query(sql, params));
                return null;
            } catch (err) {
                return (err as Error).message;
            }
        };

        it("the job role reads across users, but only the columns the jobs need", async () => {
            expect(await jobError("SELECT id, email, time_zone FROM profiles")).toBeNull();
            expect(await jobError("SELECT s.name, s.renewal_link FROM subscriptions s")).toBeNull();
            expect(await jobError("SELECT created_at FROM profiles")).toMatch(/permission denied/);
            expect(await jobError("SELECT cancellation_link FROM subscriptions")).toMatch(/permission denied/);
            // Story 10's monthly summary reads category, amount and paid_on (migration 009); not the creator or request id.
            expect(await jobError("SELECT category FROM subscriptions")).toBeNull();
            expect(await jobError("SELECT amount, paid_on FROM billing")).toBeNull();
            expect(await jobError("SELECT request_id FROM billing")).toMatch(/permission denied/);
        });

        it.each([
            // Status changes are Story 5's (lapse.security.test.ts), and limited to one transition there.
            "DELETE FROM subscriptions",
            "INSERT INTO subscriptions (user_id) VALUES (gen_random_uuid())",
            "DELETE FROM billing",
            "UPDATE profiles SET email = 'x@example.com'",
            "UPDATE profiles SET time_zone = 'UTC'",
            "DELETE FROM profiles",
            "DELETE FROM notification_log",
            "UPDATE notification_log SET dedup_key = 'x'",
            "DELETE FROM email_daily_count",
            "TRUNCATE notification_log",
        ])("the job role is refused: %s", async (sql) => {
            expect(await jobError(sql)).toMatch(/permission denied/);
        });

        it("the API role cannot read the notification log, change an email, or touch another user's profile or counter", async () => {
            const a = await person("UTC");
            const b = await person("UTC");
            await db.admin.query("INSERT INTO email_daily_count (user_id, day, sent) VALUES ($1, '2031-01-01', 3)", [b.id]);
            expect(await appError(a.id, "SELECT * FROM notification_log")).toMatch(/permission denied/);
            expect(await appError(a.id, "UPDATE profiles SET email = 'evil@example.com' WHERE id = $1", [a.id])).toMatch(/permission denied/);
            const changed = await withUserContext(db.app, a.id, (c) => c.query("UPDATE profiles SET time_zone = 'Asia/Tokyo' WHERE id = $1", [b.id]));
            expect(changed.rowCount).toBe(0);
            const counters = await withUserContext(db.app, a.id, (c) => c.query("SELECT * FROM email_daily_count WHERE user_id = $1", [b.id]));
            expect(counters.rowCount).toBe(0);
            const bumped = await withUserContext(db.app, a.id, (c) => c.query("UPDATE email_daily_count SET sent = 0 WHERE user_id = $1", [b.id]));
            expect(bumped.rowCount).toBe(0);
        });

        it("account deletion removes the person's log rows and counters", async () => {
            const gone = await person("UTC");
            await db.admin.query("INSERT INTO notification_log (user_id, notification_type, dedup_key) VALUES ($1, 'reminder_digest', 'reminder-digest:2031-01-01')", [gone.id]);
            await db.admin.query("INSERT INTO email_daily_count (user_id, day, sent) VALUES ($1, '2031-01-01', 1)", [gone.id]);
            await db.admin.query("DELETE FROM auth.users WHERE id = $1", [gone.id]);
            expect(await logRows(gone.id)).toBe(0);
            expect(await slotsUsed(gone.id)).toBe(0);
        });
    });
});
