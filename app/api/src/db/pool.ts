import pg from "pg";
import { z } from "zod";


// One pool shared by every request: connections are opened once and lent out, not opened per request.
export function createPool(connectionString: string): pg.Pool {
    const pool = new pg.Pool({ connectionString, max: 10 });
    // An idle connection can drop (for example when the database restarts). Without a listener that event is an unhandled 'error' and crashes the process. Log the message only: the full error object can carry connection details.
    pool.on("error", (err) => {
        console.error("idle database client error", err.message);
    });
    return pool;
}

/* Your database has a rule (the RLS policy): "app_user may see only the row whose id equals app.user_id." But the API connects as one login for everybody, so the database has no idea who the current user is. This function tells it, safely, for the length of one request, and then forgets.

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

    const client = await pool.connect();
    let discardClient = false;
    try {
        // Starts a Transaction
        await client.query("BEGIN");
        // set_config takes a bound parameter; `SET app.user_id = '...'` cannot, and would mean building SQL from a string. `true` = local to this transaction, so the value is gone at COMMIT/ROLLBACK and cannot leak to the next request that reuses this pooled connection.
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
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
