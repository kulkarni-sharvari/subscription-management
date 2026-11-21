import type pg from "pg";

// The two notification tables (migrations/003_reminders.sql). Each function takes the client of
// a transaction the caller already opened, so a log row or an email slot is kept only if the
// whole unit (record, then send) succeeds; on a failed send the caller rolls it all back.

export type NotificationType = "reminder_digest" | "escalation" | "status_changed" | "monthly_summary" | "import_summary";

// Records a notification once. True if this call recorded it; false if it was already recorded,
// which means it was already sent and must not be sent again (FR-051, NFR-041).
export async function recordOnce(
    client: pg.PoolClient,
    entry: { userId: string; type: NotificationType; dedupKey: string; subscriptionId?: string },
): Promise<boolean> {
    const { rowCount } = await client.query(
        `INSERT INTO notification_log (user_id, subscription_id, notification_type, dedup_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, notification_type, dedup_key) DO NOTHING
         RETURNING id`,
        [entry.userId, entry.subscriptionId ?? null, entry.type, entry.dedupKey],
    );
    return rowCount === 1;
}

// Takes one of today's (UTC) email slots for a user. True if a slot was free; false if the user
// already reached the cap (SEC-048). One statement, so two sends at once cannot both take the last slot.
export async function reserveEmailSlot(client: pg.PoolClient, userId: string, cap: number): Promise<boolean> {
    const { rowCount } = await client.query(
        `INSERT INTO email_daily_count AS e (user_id, day, sent)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
         ON CONFLICT (user_id, day) DO UPDATE SET sent = e.sent + 1 WHERE e.sent < $2
         RETURNING sent`,
        [userId, cap],
    );
    return rowCount === 1;
}

// Emails sent today (UTC) to all users together. Cross-user: only the job role can see every row.
export async function emailsSentTodayForAllUsers(db: Pick<pg.Pool, "query">): Promise<number> {
    const { rows } = await db.query(
        `SELECT COALESCE(SUM(sent), 0)::int AS total FROM email_daily_count WHERE day = (now() AT TIME ZONE 'UTC')::date`,
    );
    return rows[0].total;
}
