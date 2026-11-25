import type pg from "pg";
import { withUserContext } from "../db/pool.js";
import type { BillingPeriod } from "../domain/billingDates.js";

// Story 9 (FR-060 to FR-063): spending analytics, always for one user. Two different questions, answered separately:
// - "Paid in range": the billing ledger's actual amounts, counted on the day each payment was made
//   (paid_on). Every billing row is a confirmed payment (BR-012), lapsed or not.
// - "Monthly cost": what the active recurring subscriptions cost per month right now, each price
//   converted to a monthly figure (FR-063). active-unknown ones are left out of it and listed
//   separately as pending reconciliation (Story 5, Story 9).

const MONTHS: Record<BillingPeriod, number> = { monthly: 1, "6_months": 6, annually: 12 };

export interface SpendingReport {
    range: { from: string; to: string };
    paid: {
        total: number;
        payments: number;
        byCategory: Array<{ category: string; total: number; payments: number }>;
        byMonth: Array<{ month: string; total: number }>;
        recurring: { total: number; payments: number };
        oneTime: { total: number; payments: number };
    };
    monthlyCost: {
        total: number;
        subscriptions: number;
        byCategory: Array<{ category: string; monthly: number }>;
    };
    statusCounts: { active: number; activeUnknown: number; inactive: number };
    pendingReconciliation: Array<{ id: string; name: string; category: string; renewalDate: string | null; monthlyCost: number }>;
}

// Money is added up in whole cents, so 0.1 + 0.2 never shows as 0.30000000000000004.
const cents = (amount: string | number) => Math.round(Number(amount) * 100);
const toMoney = (c: number) => Math.round(c) / 100;
// Largest first, then by name, so the order is stable.
const byAmount = <T extends { category: string }>(key: keyof T) => (a: T, b: T) => (b[key] as number) - (a[key] as number) || a.category.localeCompare(b.category);

export function createAnalyticsRepository(pool: pg.Pool) {
    return {
        async spending(userId: string, from: string, to: string): Promise<SpendingReport> {
            return withUserContext(pool, userId, (client) => spendingReport(client, userId, from, to));
        },
    };
}

// The report for one user, on a client the caller opened: the API's (as that user, under RLS) or
// the monthly job's (job_runner). Every query filters by the user id either way.
export async function spendingReport(client: pg.PoolClient, userId: string, from: string, to: string): Promise<SpendingReport> {
    const paidRows = (
        await client.query(
            `SELECT s.category, s.subscription_type, to_char(b.paid_on, 'YYYY-MM') AS month,
                    SUM(b.amount)::text AS total, COUNT(*)::int AS payments
               FROM billing b
               JOIN subscriptions s ON s.id = b.subscription_id AND s.user_id = b.user_id
              WHERE b.user_id = $1 AND b.paid_on BETWEEN $2::date AND $3::date
              GROUP BY 1, 2, 3`,
            [userId, from, to],
        )
    ).rows;

    const current = (
        await client.query(
            `SELECT s.id, s.name, s.category, s.status, s.price::text AS price, s.billing_period, c.due_date
               FROM subscriptions s
               LEFT JOIN LATERAL (
                    SELECT b.due_date FROM billing b
                     WHERE b.subscription_id = s.id AND b.user_id = s.user_id
                     ORDER BY b.due_date DESC LIMIT 1
               ) c ON true
              WHERE s.user_id = $1 AND s.subscription_type = 'recurring' AND s.status IN ('active', 'active-unknown')
              ORDER BY s.name, s.id`,
            [userId],
        )
    ).rows;

    const counts = (
        await client.query("SELECT status, COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1 GROUP BY status", [userId])
    ).rows;

    // Paid in range.
    const byCategory = new Map<string, { total: number; payments: number }>();
    const byMonth = new Map<string, number>();
    const recurring = { total: 0, payments: 0 };
    const oneTime = { total: 0, payments: 0 };
    for (const row of paidRows) {
        const c = cents(row.total);
        const cat = byCategory.get(row.category) ?? { total: 0, payments: 0 };
        byCategory.set(row.category, { total: cat.total + c, payments: cat.payments + row.payments });
        byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + c);
        const kind = row.subscription_type === "recurring" ? recurring : oneTime;
        kind.total += c;
        kind.payments += row.payments;
    }

    // Monthly cost of the active ones; active-unknown listed apart.
    const monthlyByCategory = new Map<string, number>();
    let monthlyTotal = 0;
    let activeCount = 0;
    const pending: SpendingReport["pendingReconciliation"] = [];
    for (const row of current) {
        const monthly = cents(row.price) / MONTHS[row.billing_period as BillingPeriod];
        if (row.status === "active") {
            monthlyTotal += monthly;
            activeCount++;
            monthlyByCategory.set(row.category, (monthlyByCategory.get(row.category) ?? 0) + monthly);
        } else {
            pending.push({ id: row.id, name: row.name, category: row.category, renewalDate: row.due_date, monthlyCost: toMoney(monthly) });
        }
    }

    const n = (status: string) => counts.find((r) => r.status === status)?.n ?? 0;
    return {
        range: { from, to },
        paid: {
            total: toMoney(recurring.total + oneTime.total),
            payments: recurring.payments + oneTime.payments,
            byCategory: [...byCategory].map(([category, v]) => ({ category, total: toMoney(v.total), payments: v.payments })).sort(byAmount("total")),
            byMonth: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total: toMoney(total) })),
            recurring: { total: toMoney(recurring.total), payments: recurring.payments },
            oneTime: { total: toMoney(oneTime.total), payments: oneTime.payments },
        },
        monthlyCost: {
            total: toMoney(monthlyTotal),
            subscriptions: activeCount,
            byCategory: [...monthlyByCategory].map(([category, monthly]) => ({ category, monthly: toMoney(monthly) })).sort(byAmount("monthly")),
        },
        statusCounts: { active: n("active"), activeUnknown: n("active-unknown"), inactive: n("inactive") },
        pendingReconciliation: pending,
    };
}

export type AnalyticsRepository = ReturnType<typeof createAnalyticsRepository>;
