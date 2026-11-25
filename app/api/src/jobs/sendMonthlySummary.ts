import type pg from "pg";
import { withTransaction } from "../db/pool.js";
import { addDays } from "../domain/billingDates.js";
import { isValidTimeZone, localDateAndHour } from "../domain/timeZones.js";
import { unsubscribeToken } from "../domain/unsubscribeToken.js";
import { spendingReport } from "../repositories/analyticsRepository.js";
import { recordOnce } from "../repositories/notificationLogRepository.js";
import { findMonthlySummaryRecipients } from "../repositories/profileRepository.js";
import type { NotificationService } from "../services/notificationService.js";
import { SEND_HOUR } from "./sendReminders.js";

export interface MonthlySummaryRunResult {
    // Opted-in users for whom it is the 1st, from 09:00, in their own time zone.
    usersDue: number;
    sent: number;
    alreadySent: number;
    // No subscriptions and nothing paid last month: nothing worth an email (recorded, not sent).
    nothingToReport: number;
    capped: number;
    failed: number;
}

class CapReached extends Error {}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The calendar month before the given date: its first and last day, and its name.
export function previousMonth(date: string): { from: string; to: string; key: string; name: string } {
    const to = addDays(`${date.slice(0, 7)}-01`, -1);
    const key = to.slice(0, 7);
    return { from: `${key}-01`, to, key, name: `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` };
}

// The monthly summary (Story 10, FR-052). Called hourly like the digest: each opted-in user gets it
// in the first run from 09:00 on the 1st of their month, about the month that just ended. The log
// row "monthly:YYYY-MM" makes it once per user per month however often the job runs (FR-051).
// Runs as job_runner.
export function createSendMonthlySummaryJob(deps: {
    pool: pg.Pool;
    notifications: Pick<NotificationService, "monthlySummary">;
    // The web app's origin (CORS_ORIGIN): links in the email point there.
    appUrl: string;
    // EMAIL_LINK_SECRET: signs the unsubscribe links.
    linkSecret: string;
    now?: () => Date;
}) {
    const now = deps.now ?? (() => new Date());

    return {
        async run(): Promise<MonthlySummaryRunResult> {
            const result: MonthlySummaryRunResult = { usersDue: 0, sent: 0, alreadySent: 0, nothingToReport: 0, capped: 0, failed: 0 };
            const moment = now();
            const utcToday = moment.toISOString().slice(0, 10);
            // It is the 1st somewhere only while UTC's date is the last day of a month, the 1st or
            // the 2nd (every zone is within a day of UTC). On every other day there is nothing to do.
            const day = Number(utcToday.slice(8, 10));
            if (day > 2 && !addDays(utcToday, 1).endsWith("-01")) return result;

            for (const recipient of await findMonthlySummaryRecipients(deps.pool)) {
                const timeZone = isValidTimeZone(recipient.timeZone) ? recipient.timeZone : "UTC";
                const local = localDateAndHour(moment, timeZone);
                if (!local.date.endsWith("-01") || local.hour < SEND_HOUR) continue;
                result.usersDue++;
                const month = previousMonth(local.date);

                // One transaction per user: record "sent for this month", then send. A failed send or
                // the cap rolls the record back, so a later run that day tries again. If the commit
                // fails after a send, the retry reuses the same idempotency key and the provider does
                // not deliver it again. One user's failure never stops the others.
                try {
                    const outcome = await withTransaction(deps.pool, async (client) => {
                        const fresh = await recordOnce(client, { userId: recipient.userId, type: "monthly_summary", dedupKey: `monthly:${month.key}` });
                        if (!fresh) return "alreadySent" as const;
                        const report = await spendingReport(client, recipient.userId, month.from, month.to);
                        const { active, activeUnknown } = report.statusCounts;
                        if (active + activeUnknown === 0 && report.paid.payments === 0) return "nothingToReport" as const;

                        const query = `u=${encodeURIComponent(recipient.userId)}&t=${unsubscribeToken(deps.linkSecret, recipient.userId)}`;
                        const sent = await deps.notifications.monthlySummary(
                            client,
                            recipient,
                            [report, month.name, { spending: `${deps.appUrl}/analytics`, unsubscribe: `${deps.appUrl}/unsubscribe?${query}` }],
                            `${deps.appUrl}/api/v1/email/unsubscribe?${query}`,
                            `monthly-summary/${recipient.userId}/${month.key}`,
                        );
                        if (sent === "capped") throw new CapReached();
                        return "sent" as const;
                    });
                    result[outcome]++;
                } catch (err) {
                    if (err instanceof CapReached) {
                        result.capped++;
                        console.warn("email not sent: daily cap reached", { userId: recipient.userId, kind: "monthly_summary" });
                    } else {
                        result.failed++;
                        // No address and no provider text in the log (SEC-019).
                        console.error("monthly summary failed", { userId: recipient.userId, reason: err instanceof Error ? err.message : "unknown" });
                    }
                }
            }
            return result;
        },
    };
}

export type SendMonthlySummaryJob = ReturnType<typeof createSendMonthlySummaryJob>;
