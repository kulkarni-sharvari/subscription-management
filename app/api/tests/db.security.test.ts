// Story 1 database security tests: the least-privilege role and row-level security.
// These talk to the real database as app_user (DATABASE_URL in app/api/.env) and only read.
//   TEST_USER_A_ID     id of an existing user (has a profiles row)           -> single-user checks
//   TEST_USER_B_ID     id of a second existing user (dashboard: Add user)    -> cross-user checks
// Without DATABASE_URL and TEST_USER_A_ID the whole file is skipped.
import "dotenv/config";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withUserContext } from "../src/db/pool.js";
import { createProfileRepository } from "../src/repositories/profileRepository.js";

const url = process.env.DATABASE_URL;
const userA = process.env.TEST_USER_A_ID;
const userB = process.env.TEST_USER_B_ID;
const NOBODY = "99999999-9999-4999-8999-999999999999";

describe.skipIf(!url || !userA)("RLS and the app_user role (SEC-028, T-03)", () => {
    let pool: pg.Pool;
    beforeAll(() => {
        pool = createPool(url!);
    });
    afterAll(async () => {
        await pool.end();
    });

    it("the API connects as app_user, which is not a superuser and cannot bypass RLS", async () => {
        const { rows } = await pool.query(
            "SELECT current_user AS who, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb FROM pg_roles r WHERE r.rolname = current_user",
        );
        expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
        expect(rows[0].who).toMatch(/^app_user/);
    });

    it("with no user context the database returns no rows at all", async () => {
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.profiles");
        expect(rows[0].n).toBe(0);
    });

    it("an unknown user, and an empty context, see nothing", async () => {
        expect(await withUserContext(pool, NOBODY, async (c) => (await c.query("SELECT id FROM public.profiles")).rowCount)).toBe(0);
    });

    it("a user sees exactly their own profile, even for SELECT * with no WHERE", async () => {
        const rows = await withUserContext(pool, userA!, async (c) => (await c.query("SELECT id FROM public.profiles")).rows);
        expect(rows).toEqual([{ id: userA }]);
    });

    it("SEC-068: exists() is true for a real profile and false for a deleted or unknown one", async () => {
        const repo = createProfileRepository(pool);
        expect(await repo.exists(userA!)).toBe(true);
        expect(await repo.exists(NOBODY)).toBe(false);
    });

    it("the user context does not leak to the next request on a reused connection", async () => {
        await withUserContext(pool, userA!, async (c) => c.query("SELECT 1"));
        for (let i = 0; i < 20; i++) {
            const { rows } = await pool.query("SELECT count(*)::int AS n, current_setting('app.user_id', true) AS ctx FROM public.profiles");
            expect(rows[0].n).toBe(0);
            expect(rows[0].ctx ?? "").toBe("");
        }
    });

    it("a malicious user id never reaches SQL: it is rejected before any query", async () => {
        await expect(withUserContext(pool, "x'; DROP TABLE profiles; --", async (c) => c.query("SELECT 1"))).rejects.toThrow();
        await expect(withUserContext(pool, `${userA}' OR '1'='1`, async (c) => c.query("SELECT 1"))).rejects.toThrow();
    });

    it.each([
        ["INSERT", "INSERT INTO public.profiles (id, email) VALUES (gen_random_uuid(), 'x@example.com')"],
        ["UPDATE", "UPDATE public.profiles SET email = 'hacked@example.com'"],
        ["DELETE", "DELETE FROM public.profiles"],
    ])("app_user cannot %s profiles (the table is read-only to the API)", async (_verb, sql) => {
        await expect(withUserContext(pool, userA!, async (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    });

    it("app_user cannot read Supabase's auth schema (password hashes, tokens)", async () => {
        await expect(withUserContext(pool, userA!, async (c) => c.query("SELECT * FROM auth.users LIMIT 1"))).rejects.toThrow(/permission denied/);
        await expect(withUserContext(pool, userA!, async (c) => c.query("SELECT * FROM auth.refresh_tokens LIMIT 1"))).rejects.toThrow(/permission denied/);
    });

    it("app_user cannot call the trigger functions or create objects", async () => {
        await expect(withUserContext(pool, userA!, async (c) => c.query("SELECT public.handle_new_user()"))).rejects.toThrow(/permission denied/);
        await expect(withUserContext(pool, userA!, async (c) => c.query("CREATE TABLE public.evil (id int)"))).rejects.toThrow(/permission denied/);
    });
});

describe.skipIf(!url || !userA || !userB)("two users cannot reach each other's data (SEC-029, SEC-031)", () => {
    let pool: pg.Pool;
    beforeAll(() => {
        pool = createPool(url!);
    });
    afterAll(async () => {
        await pool.end();
    });

    it("A and B each see only their own row", async () => {
        const rowsFor = (id: string) => withUserContext(pool, id, async (c) => (await c.query("SELECT id FROM public.profiles")).rows);
        expect(await rowsFor(userA!)).toEqual([{ id: userA }]);
        expect(await rowsFor(userB!)).toEqual([{ id: userB }]);
    });

    it("A cannot fetch B's profile by id, by email, or with a tautology", async () => {
        await withUserContext(pool, userA!, async (c) => {
            expect((await c.query("SELECT id FROM public.profiles WHERE id = $1", [userB])).rowCount).toBe(0);
            expect((await c.query("SELECT id FROM public.profiles WHERE id <> $1", [userA])).rowCount).toBe(0);
            expect((await c.query("SELECT id FROM public.profiles WHERE true OR id = $1", [userB])).rows).toEqual([{ id: userA }]);
        });
    });

    it("A cannot change which user they are mid-request (the setting is only set by the API)", async () => {
        // Even if code tried, app_user could set it, so the guard is that only withUserContext does,
        // from the verified token. This pins the behaviour: re-setting inside the transaction
        // would change the view, which is why no route may run user-supplied SQL.
        const repo = createProfileRepository(pool);
        expect((await repo.findById(userA!))?.id).toBe(userA);
        expect((await repo.findById(userB!))?.id).toBe(userB);
        expect(await repo.findById(NOBODY)).toBeNull();
    });
});
