import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { addDays, daysBetween } from "../domain/billingDates.js";
import { isValidTimeZone, localDateAndHour } from "../domain/timeZones.js";
import type { DigestItem } from "../email/templates.js";
import { emailsSentTodayForAllUsers, recordOnce } from "../repositories/notificationLogRepository.js";
import { findReminderCandidatesForAllUsers, type ReminderCandidate } from "../repositories/subscriptionRepository.js";
import type { NotificationService } from "../services/notificationService.js";

// Reminders go out from this hour of the user's own morning. The job runs every hour, so each user
// gets their digest in the first run at or after 09:00 their time (or a later run that day, if one is missed).
export const SEND_HOUR = 9;
// A subscription is in the digest on each of the 5 days before it renews (FR-050).
export const FIRST_REMINDER_DAYS = 5;
// Resend's free plan sends at most 100 emails a day; a warning is logged at 80% (SEC-048).
export const PROVIDER_DAILY_LIMIT = 100;

export interface ReminderRunResult {
    // Users with at least one subscription 1 to 5 days from renewal, in their own calendar.
    usersDue: number;
    sent: number;
    // Already sent a digest today (an earlier run, or a retry).
    alreadySent: number;
    // Not yet 09:00 where the user is.
    notYetMorning: number;
    capped: number;
    failed: number;
}

class CapReached extends Error {}

// The daily renewal digest (Story 4): one email per user per local day, listing every active
// recurring subscription that renews in 1 to 5 days (FR-050, BR-007). Runs as job_runner.
export function createSendRemindersJob(deps: {
    pool: pg.Pool;
    notifications: Pick<NotificationService, "renewalDigest">;
    now?: () => Date;
}) {
    const now = deps.now ?? (() => new Date());

    return {
        async run(): Promise<ReminderRunResult> {
            const moment = now();
            const utcToday = moment.toISOString().slice(0, 10);
            // Every time zone's "today" lies within one day of UTC's, so this window covers any
            // renewal 1 to 5 days away for every user. The exact days are worked out per user below.
            const candidates = await findReminderCandidatesForAllUsers(deps.pool, utcToday, addDays(utcToday, FIRST_REMINDER_DAYS + 1));

            const byUser = new Map<string, ReminderCandidate[]>();
            for (const row of candidates) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

            const result: ReminderRunResult = { usersDue: 0, sent: 0, alreadySent: 0, notYetMorning: 0, capped: 0, failed: 0 };

            for (const [userId, rows] of byUser) {
                // The API only stores valid zones; this guards against a value written some other way.
                const timeZone = isValidTimeZone(rows[0].timeZone) ? rows[0].timeZone : "UTC";
                const local = localDateAndHour(moment, timeZone);
                const items: DigestItem[] = rows
                    .map((row) => ({ row, daysLeft: daysBetween(local.date, row.dueDate) }))
                    .filter(({ daysLeft }) => daysLeft >= 1 && daysLeft <= FIRST_REMINDER_DAYS)
                    .map(({ row, daysLeft }) => ({
                        name: row.name,
                        cost: row.cost,
                        billingPeriod: row.billingPeriod,
                        dueDate: row.dueDate,
                        daysLeft,
                        paymentMethodType: row.paymentMethodType,
                        renewalLink: row.renewalLink,
                    }));
                if (items.length === 0) continue;
                result.usersDue++;
                if (local.hour < SEND_HOUR) {
                    result.notYetMorning++;
                    continue;
                }

                // One transaction per user: record "digest sent for this local day", then send. If the
                // send fails or the cap is reached, the record is rolled back and a later run retries.
                // A failure for one user never stops the others.
                try {
                    const outcome = await withTransaction(deps.pool, async (client) => {
                        const fresh = await recordOnce(client, { userId, type: "reminder_digest", dedupKey: `reminder-digest:${local.date}` });
                        if (!fresh) return "alreadySent" as const;
                        const sent = await deps.notifications.renewalDigest(client, { userId, email: rows[0].email }, items);
                        if (sent === "capped") throw new CapReached();
                        return "sent" as const;
                    });
                    result[outcome]++;
                } catch (err) {
                    if (err instanceof CapReached) {
                        result.capped++;
                        console.warn("email not sent: daily cap reached", { userId, kind: "reminder_digest" });
                    } else {
                        result.failed++;
                        // No address and no provider text in the log (SEC-019).
                        console.error("reminder digest failed", { userId, reason: err instanceof Error ? err.message : "unknown" });
                    }
                }
            }

            const sentToday = await emailsSentTodayForAllUsers(deps.pool);
            if (sentToday >= PROVIDER_DAILY_LIMIT * 0.8) {
                console.warn("email volume near the provider's daily limit", { sentToday, limit: PROVIDER_DAILY_LIMIT });
            }
            return result;
        },
    };
}

export type SendRemindersJob = ReturnType<typeof createSendRemindersJob>;
