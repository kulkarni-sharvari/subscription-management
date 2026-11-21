// Helpers for tests that run against the throwaway local PostgreSQL (tests/setup/localPostgres.ts).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPool, withUserContext } from "../src/db/pool.js";
import type { LocalPg } from "./setup/localPostgres.js";

export interface Db {
    admin: pg.Pool;
    app: pg.Pool;
    job: pg.Pool;
    close(): Promise<void>;
}

// admin: superuser, for setting things up and for trying what even an owner must not do.
// app: the least-privilege role, exactly as the API uses it.
export function connect(local: LocalPg, appOptions: { max?: number; connectionTimeoutMillis?: number } = {}): Db {
    const admin = new pg.Pool({ connectionString: local.adminUrl, max: 3 });
    const app = createPool(local.appUrl, { max: 5, ...appOptions });
    // job: the scheduled jobs' role (cross-user reads, writes only the notification tables).
    const job = createPool(local.jobUrl, { max: 2 });
    return { admin, app, job, close: async () => void (await Promise.all([admin.end(), app.end(), job.end()])) };
}

// A user exactly as Supabase creates one: a row in auth.users. The trigger from migration 001
// then creates the profile.
export async function createUser(db: Db, email = `${randomUUID()}@example.com`): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    await db.admin.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, email]);
    return { id, email };
}

export async function addPaymentMethod(db: Db, userId: string, type = "credit_card"): Promise<string> {
    return withUserContext(db.app, userId, async (c) => {
        const { rows } = await c.query("INSERT INTO payment_methods (user_id, type) VALUES ($1, $2) RETURNING id", [userId, type]);
        return rows[0].id;
    });
}

export const SUBSCRIPTION_SQL = `
  INSERT INTO subscriptions (user_id, name, category, price, billing_period, subscription_type, start_date, payment_method_id, renewal_link)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;

// A valid recurring subscription row; pass overrides to make it invalid in one way.
export async function addSubscription(
    db: Db,
    userId: string,
    paymentMethodId: string,
    o: { name?: string; category?: string; price?: number | string; period?: string | null; type?: string; renewalLink?: string | null } = {},
): Promise<string> {
    return withUserContext(db.app, userId, async (c) => {
        const { rows } = await c.query(SUBSCRIPTION_SQL, [
            userId, o.name ?? "Netflix", o.category ?? "Entertainment", o.price ?? 15.49,
            o.period === undefined ? "monthly" : o.period, o.type ?? "recurring", "2026-01-31", paymentMethodId, o.renewalLink ?? null,
        ]);
        return rows[0].id;
    });
}

export const BILLING_SQL = `
  INSERT INTO billing (subscription_id, user_id, amount, payment_method_id, due_date, created_by, request_id)
  VALUES ($1, $2, $3, $4, $5, 'user', $6) RETURNING transaction_id`;

export async function addBilling(db: Db, userId: string, subscriptionId: string, paymentMethodId: string, dueDate = "2026-02-28"): Promise<string> {
    return withUserContext(db.app, userId, async (c) => {
        const { rows } = await c.query(BILLING_SQL, [subscriptionId, userId, 15.49, paymentMethodId, dueDate, "req-test"]);
        return rows[0].transaction_id;
    });
}

// Runs one statement as the user and returns the error message, or null if it succeeded.
export async function errorOf(db: Db, userId: string, sql: string, params: unknown[] = []): Promise<string | null> {
    try {
        await withUserContext(db.app, userId, (c) => c.query(sql, params));
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}
