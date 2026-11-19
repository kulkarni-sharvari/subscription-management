// Database security tests for migrations 001 and 002, against a throwaway local PostgreSQL.
// They prove the database itself refuses what the rules forbid, whatever the application code does.
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withUserContext } from "../src/db/pool.js";
import { addBilling, addPaymentMethod, addSubscription, BILLING_SQL, connect, createUser, errorOf, SUBSCRIPTION_SQL, type Db } from "./dbHelpers.js";

const local = inject("localPg");

describe.skipIf(!local)("migrations: row-level security and grants (SEC-028, SEC-029, SEC-031, SEC-034, T-03)", () => {
    let db: Db;
    let a: { id: string }, b: { id: string };
    let pmA: string, pmB: string, subA: string, subB: string;

    beforeAll(async () => {
        db = connect(local!);
        a = await createUser(db);
        b = await createUser(db);
        pmA = await addPaymentMethod(db, a.id);
        pmB = await addPaymentMethod(db, b.id, "debit_card");
        subA = await addSubscription(db, a.id, pmA, { name: "A's Netflix" });
        subB = await addSubscription(db, b.id, pmB, { name: "B's Spotify" });
        await addBilling(db, a.id, subA, pmA);
        await addBilling(db, b.id, subB, pmB);
    });
    afterAll(() => db.close());

    const count = (userId: string | null, table: string) =>
        userId
            ? withUserContext(db.app, userId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
            : db.app.query(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0].n);

    describe("isolation", () => {
        it.each(["payment_methods", "subscriptions", "billing"])("each user sees exactly their own rows in %s", async (table) => {
            expect(await count(a.id, table)).toBe(1);
            expect(await count(b.id, table)).toBe(1);
        });

        it.each(["payment_methods", "subscriptions", "billing"])("with no user context %s returns nothing (fails closed)", async (table) => {
            expect(await count(null, table)).toBe(0);
        });

        it("a user cannot reach the other's row by id, by tautology, or by a join", async () => {
            await withUserContext(db.app, a.id, async (c) => {
                expect((await c.query("SELECT 1 FROM subscriptions WHERE id = $1", [subB])).rowCount).toBe(0);
                expect((await c.query("SELECT 1 FROM subscriptions WHERE true OR id = $1", [subB])).rowCount).toBe(1);
                expect((await c.query("SELECT 1 FROM billing b JOIN subscriptions s ON s.id = b.subscription_id WHERE s.id = $1", [subB])).rowCount).toBe(0);
            });
        });
    });

    describe("a user cannot attach their data to someone else's (SEC-031)", () => {
        it("a subscription cannot use another user's payment method (composite foreign key)", async () => {
            const message = await errorOf(db, a.id, SUBSCRIPTION_SQL, [a.id, "x", "c", 1, "monthly", "recurring", "2026-01-01", pmB, null]);
            expect(message).toMatch(/foreign key/);
        });

        it("a subscription cannot be created for another user (insert policy)", async () => {
            const message = await errorOf(db, a.id, SUBSCRIPTION_SQL, [b.id, "x", "c", 1, "monthly", "recurring", "2026-01-01", pmB, null]);
            expect(message).toMatch(/row-level security/);
        });

        it("a payment method cannot be created for another user", async () => {
            expect(await errorOf(db, a.id, "INSERT INTO payment_methods (user_id, type) VALUES ($1, 'apple_pay')", [b.id])).toMatch(/row-level security/);
        });

        it("a billing row cannot be created for another user", async () => {
            const message = await errorOf(db, a.id, BILLING_SQL, [subB, b.id, 1, pmB, "2026-03-01", "x"]);
            expect(message).toMatch(/row-level security/);
        });

        it("a billing row cannot point at another user's subscription or payment method, even under the caller's own id", async () => {
            expect(await errorOf(db, a.id, BILLING_SQL, [subB, a.id, 1, pmA, "2026-03-01", "x"])).toMatch(/row-level security/);
            expect(await errorOf(db, a.id, BILLING_SQL, [subA, a.id, 1, pmB, "2026-03-01", "x"])).toMatch(/row-level security/);
        });
    });

    describe("the application role has read and insert only (least privilege)", () => {
        it.each(["payment_methods", "subscriptions", "billing"])("UPDATE, DELETE and TRUNCATE on %s are denied", async (table) => {
            for (const sql of [`UPDATE ${table} SET created_at = now()`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
                expect(await errorOf(db, a.id, sql), sql).toMatch(/permission denied/);
            }
        });

        it("cannot create objects, read auth.users, or call the trigger function", async () => {
            expect(await errorOf(db, a.id, "CREATE TABLE public.evil (id int)")).toMatch(/permission denied/);
            expect(await errorOf(db, a.id, "SELECT * FROM auth.users")).toMatch(/permission denied/);
            expect(await errorOf(db, a.id, "SELECT public.enforce_billing_immutability()")).toMatch(/permission denied/);
        });

        it("the Data API roles (anon, authenticated) have no access at all", async () => {
            for (const role of ["anon", "authenticated"]) {
                for (const table of ["profiles", "payment_methods", "subscriptions", "billing"]) {
                    const { rows } = await db.admin.query(
                        "SELECT has_table_privilege($1, $2, 'SELECT') AS sel, has_table_privilege($1, $2, 'INSERT') AS ins",
                        [role, `public.${table}`],
                    );
                    expect(rows[0], `${role} on ${table}`).toEqual({ sel: false, ins: false });
                }
            }
        });
    });

    describe("data rules the database enforces on its own (SEC-035, BR-011, BR-017, SEC-041)", () => {
        const create = (o: Parameters<typeof addSubscription>[3]) => addSubscription(db, a.id, pmA, o).then(() => null, (e: Error) => e.message);

        it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x", "ftp://example.com", "//example.com", `https://${"a".repeat(2050)}`])(
            "refuses the link %j",
            async (renewalLink) => {
                expect(await create({ renewalLink })).toMatch(/check constraint/);
            },
        );

        it("accepts http and https links", async () => {
            expect(await create({ renewalLink: "https://example.com/renew" })).toBeNull();
            expect(await create({ renewalLink: "http://example.com/renew" })).toBeNull();
        });

        it("refuses an empty or over-long name, an over-long category, and a cost of zero or less", async () => {
            expect(await create({ name: "" })).toMatch(/check constraint/);
            expect(await create({ name: "x".repeat(101) })).toMatch(/check constraint/);
            expect(await create({ category: "x".repeat(51) })).toMatch(/check constraint/);
            expect(await create({ price: 0 })).toMatch(/check constraint/);
            expect(await create({ price: -5 })).toMatch(/check constraint/);
        });

        it("refuses a recurring subscription without a period and a one-time one with a period", async () => {
            expect(await create({ period: null })).toMatch(/billing_period_matches_type/);
            expect(await create({ type: "one_time" })).toMatch(/billing_period_matches_type/);
            expect(await create({ type: "one_time", period: null })).toBeNull();
        });

        it("allows one billing cycle per subscription per due date (a double submit makes one row)", async () => {
            const message = await errorOf(db, a.id, BILLING_SQL, [subA, a.id, 15.49, pmA, "2026-02-28", "again"]);
            expect(message).toMatch(/duplicate key/);
        });
    });

    describe("the billing ledger is immutable (SEC-042, BR-021)", () => {
        // Even the table owner is stopped by the trigger: it is a backstop for a bug in the API.
        const asAdmin = (sql: string, params: unknown[] = []) => db.admin.query(sql, params).then(() => null, (e: Error) => e.message);

        it("refuses to change the amount, the due date, the creator or the request id", async () => {
            for (const set of ["amount = 0.01", "due_date = '2030-01-01'", "created_by = 'system'", "request_id = 'forged'"]) {
                expect(await asAdmin(`UPDATE billing SET ${set} WHERE subscription_id = $1`, [subA]), set).toMatch(/immutable/);
            }
        });

        it("refuses every delete", async () => {
            expect(await asAdmin("DELETE FROM billing WHERE subscription_id = $1", [subA])).toMatch(/cannot be deleted/);
        });

        it("refuses to move a ledger row to another user, subscription or payment method", async () => {
            expect(await asAdmin("UPDATE billing SET user_id = $1 WHERE subscription_id = $2", [b.id, subA])).toMatch(/can only be cleared/);
            expect(await asAdmin("UPDATE billing SET subscription_id = $1 WHERE subscription_id = $2", [subB, subA])).toMatch(/can only be cleared/);
            expect(await asAdmin("UPDATE billing SET payment_method_id = $1 WHERE subscription_id = $2", [pmB, subA])).toMatch(/can only be cleared/);
        });

        it("refuses to detach a living user's row (setting a link to NULL while its target exists)", async () => {
            for (const column of ["user_id", "subscription_id", "payment_method_id"]) {
                expect(await asAdmin(`UPDATE billing SET ${column} = NULL WHERE subscription_id = $1`, [subA]), column).toMatch(/can only be cleared/);
            }
        });

        it("allows only the single paid to due lapse", async () => {
            const user = await createUser(db);
            const pm = await addPaymentMethod(db, user.id);
            const sub = await addSubscription(db, user.id, pm);
            await addBilling(db, user.id, sub, pm, "2026-05-01");
            expect(await asAdmin("UPDATE billing SET status = 'due' WHERE subscription_id = $1", [sub])).toBeNull();
            expect(await asAdmin("UPDATE billing SET status = 'paid' WHERE subscription_id = $1", [sub])).toMatch(/only support a paid -> due/);
        });
    });

    describe("account deletion keeps the ledger but removes every link to the person (BR-036, SEC-065, SEC-066)", () => {
        it("deleting the auth user removes their data and de-identifies their billing rows, and only theirs", async () => {
            const victim = await createUser(db);
            const pm = await addPaymentMethod(db, victim.id);
            const sub = await addSubscription(db, victim.id, pm);
            await addBilling(db, victim.id, sub, pm, "2026-06-01");

            await db.admin.query("DELETE FROM auth.users WHERE id = $1", [victim.id]);

            const gone = await db.admin.query(
                `SELECT (SELECT count(*) FROM profiles WHERE id = $1) AS profiles,
                        (SELECT count(*) FROM subscriptions WHERE id = $2) AS subs,
                        (SELECT count(*) FROM payment_methods WHERE id = $3) AS methods`,
                [victim.id, sub, pm],
            );
            expect(gone.rows[0]).toEqual({ profiles: "0", subs: "0", methods: "0" });

            const ledger = await db.admin.query("SELECT user_id, subscription_id, payment_method_id, amount, due_date FROM billing WHERE due_date = '2026-06-01'");
            expect(ledger.rows).toEqual([{ user_id: null, subscription_id: null, payment_method_id: null, amount: "15.49", due_date: "2026-06-01" }]);

            // Nobody else is touched.
            expect(await count(a.id, "billing")).toBe(1);
            expect(await count(b.id, "subscriptions")).toBe(1);
        });
    });
});
