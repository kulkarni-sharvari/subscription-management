import pg from "pg";
import { z } from "zod";
import { ServiceUnavailableError } from "../errors.js";

// A DATE column is a calendar day, not a moment. The driver's default turns it into a Date at
// local midnight, which shifts the day when the server's time zone changes. Keep it as the
// 'YYYY-MM-DD' text the database sends.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(
    connectionString: string,
    options: { max?: number; connectionTimeoutMillis?: number } = {},
): pg.Pool {
    const pool = new pg.Pool({
        connectionString,
        max: options.max ?? 10,
        // When all connections are busy a request waits for one. Without a limit the queue grows
        // without bound and every request gets slower; with it, a request that waits too long fails
        // fast with a 503 and the API stays responsive.
        connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
        // Connections idle for this long are closed, so a quiet server does not hold database slots.
        idleTimeoutMillis: 30_000,
    });
    pool.on("error", (err) => {
        console.error("idle database client error", err.message);
    });
    return pool;
}

// Runs fn inside one transaction on one pooled connection: COMMIT if it returns, ROLLBACK if it
// throws. Used directly only by the scheduled jobs (their role is cross-user by design); every
// user request goes through withUserContext below.
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
        client = await pool.connect();
    } catch (err) {
        // Pool exhausted for too long, or the database is unreachable: either way the API cannot serve this request right now.
        console.error("could not get a database connection:", err instanceof Error ? err.message : err);
        throw new ServiceUnavailableError();
    }
    let discardClient = false;
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        try {
            await client.query("ROLLBACK");
        } catch {
            // The connection itself is broken; do not return it to the pool.
            discardClient = true;
        }
        throw err;
    } finally {
        // Must always run, or the pool leaks connections and eventually stops serving requests.
        client.release(discardClient);
    }
}

/* The database has a rule (the RLS policy): "app_user may see only the row whose id equals app.user_id." But the API connects as one login for everybody, so the database has no idea who the current user is. This function tells it, safely, for the length of one request, and then forgets.

pool: pg.Pool,   the shared set of database connections.
userId: string,  who this request is for. Comes from JWT
fn: (client: pg.PoolClient) callback or functionality .
*/
export async function withUserContext<T>(
    pool: pg.Pool,
    userId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
    // userId comes from the verified token's `sub`validating the token
    z.uuid().parse(userId);

    return withTransaction(pool, async (client) => {
        // set_config takes a bound parameter; `SET app.user_id = '...'` cannot, and would mean building SQL from a string. `true` = local to this transaction, so the value is gone at COMMIT/ROLLBACK and cannot leak to the next request that reuses this pooled connection.
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        return fn(client);
    });
}
