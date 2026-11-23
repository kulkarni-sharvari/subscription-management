import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { isValidTimeZone, localDateAndHour } from "../domain/timeZones.js";
import { findUsersWithOverdueForAllUsers, lapseOverdueForUser } from "../repositories/subscriptionRepository.js";

export interface OverdueRunResult {
    // Users with at least one subscription lapsed by this run.
    usersLapsed: number;
    subscriptionsLapsed: number;
    // Nothing changed for this user; the next run tries again.
    failed: number;
}

// Story 5 (FR-033, FR-045, BR-006): a subscription whose renewal date has ended, in the user's
// own time zone, with no renewal or cancellation recorded, becomes active-unknown and its current
// cycle becomes due. Runs hourly as job_runner, so each user is handled in the first run after
// their local midnight. It sends no email: the next 09:00 digest tells the user (sendReminders.ts).
export function createTransitionOverdueJob(deps: { pool: pg.Pool; now?: () => Date }) {
    const now = deps.now ?? (() => new Date());

    return {
        async run(): Promise<OverdueRunResult> {
            const moment = now();
            const utcToday = moment.toISOString().slice(0, 10);
            const users = await findUsersWithOverdueForAllUsers(deps.pool, utcToday);
            const result: OverdueRunResult = { usersLapsed: 0, subscriptionsLapsed: 0, failed: 0 };

            for (const user of users) {
                const timeZone = isValidTimeZone(user.timeZone) ? user.timeZone : "UTC";
                const localToday = localDateAndHour(moment, timeZone).date;
                // The due date is still today (or later) where the user is: not lapsed yet.
                if (user.earliestDueDate >= localToday) continue;

                // One transaction per user, so a failure for one user never stops the others.
                try {
                    const lapsed = await withTransaction(deps.pool, (client) => lapseOverdueForUser(client, user.userId, localToday));
                    if (lapsed.length === 0) continue; // a renewal or another run got there first
                    result.usersLapsed++;
                    result.subscriptionsLapsed += lapsed.length;
                } catch (err) {
                    result.failed++;
                    console.error("overdue transition failed", { userId: user.userId, reason: err instanceof Error ? err.message : "unknown" });
                }
            }
            return result;
        },
    };
}

export type TransitionOverdueJob = ReturnType<typeof createTransitionOverdueJob>;
