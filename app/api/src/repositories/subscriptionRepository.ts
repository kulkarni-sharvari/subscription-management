import type pg from "pg";
import { withUserContext } from "../db/pool.js";
import type { BillingPeriod } from "../domain/billingDates.js";
import { ValidationError } from "../errors.js";
import type { PaymentMethodType } from "./paymentMethodRepository.js";

export type SubscriptionType = "recurring" | "one_time";
export type SubscriptionStatus = "active" | "active-unknown" | "inactive";

// What the caller supplies; the user id comes separately, from the verified token.
export interface NewSubscription {
    name: string;
    category: string;
    cost: number;
    subscriptionType: SubscriptionType;
    billingPeriod: BillingPeriod | null;
    startDate: string;
    paymentMethodId: string;
    renewalLink: string | null;
    cancellationLink: string | null;
    autoRenews: boolean;
}

export interface FirstCycle {
    dueDate: string;
    requestId: string;
}

export interface SubscriptionListItem {
    id: string;
    name: string;
    category: string;
    cost: number;
    billingPeriod: BillingPeriod | null;
    subscriptionType: SubscriptionType;
    status: SubscriptionStatus;
    autoRenews: boolean;
    paymentMethod: { id: string; type: PaymentMethodType };
    currentCycle: { dueDate: string; status: "paid" | "due" } | null;
}

export interface SubscriptionDetail extends SubscriptionListItem {
    renewalLink: string | null;
    cancellationLink: string | null;
    startDate: string;
    createdAt: Date;
    updatedAt: Date;
}

// Fixed ORDER BY text per status, chosen from this map: a request value is never put into SQL (SEC-033).
const ORDER_BY: Record<SubscriptionStatus, string> = {
    active: "c.due_date ASC NULLS LAST, s.name",
    "active-unknown": "c.due_date ASC NULLS LAST, s.name",
    inactive: "s.name",
};

export function createSubscriptionRepository(pool: pg.Pool) {
    return {
        // Saves the subscription and its first billing row together: both or neither (FR-011, FR-044).
        async createWithFirstBilling(userId: string, input: NewSubscription, cycle: FirstCycle): Promise<SubscriptionDetail> {
            return withUserContext(pool, userId, async (client) => {
                // The payment method must be the caller's own and still active. A missing one and
                // someone else's give the same answer, so ids of other users cannot be probed (SEC-031).
                const method = await client.query(
                    "SELECT id, type FROM payment_methods WHERE id = $1 AND user_id = $2 AND is_active",
                    [input.paymentMethodId, userId],
                );
                if (method.rowCount !== 1) {
                    throw new ValidationError("Choose one of your active payment methods", "paymentMethodId");
                }

                const { rows } = await client.query(
                    `INSERT INTO subscriptions
                       (user_id, name, category, price, billing_period, subscription_type, start_date,
                        payment_method_id, renewal_link, cancellation_link, auto_renews)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING id, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
                    [
                        userId, input.name, input.category, input.cost.toFixed(2), input.billingPeriod,
                        input.subscriptionType, input.startDate, input.paymentMethodId,
                        input.renewalLink, input.cancellationLink, input.autoRenews,
                    ],
                );
                const created = rows[0];

                await client.query(
                    `INSERT INTO billing
                       (subscription_id, user_id, amount, payment_method_id, status, due_date, created_by, request_id)
                     VALUES ($1, $2, $3, $4, 'paid', $5, 'user', $6)`,
                    [created.id, userId, input.cost.toFixed(2), input.paymentMethodId, cycle.dueDate, cycle.requestId],
                );

                return {
                    id: created.id,
                    name: input.name,
                    category: input.category,
                    cost: input.cost,
                    billingPeriod: input.billingPeriod,
                    subscriptionType: input.subscriptionType,
                    status: created.status,
                    autoRenews: input.autoRenews,
                    paymentMethod: { id: method.rows[0].id, type: method.rows[0].type },
                    currentCycle: { dueDate: cycle.dueDate, status: "paid" },
                    renewalLink: input.renewalLink,
                    cancellationLink: input.cancellationLink,
                    startDate: input.startDate,
                    createdAt: created.createdAt,
                    updatedAt: created.updatedAt,
                };
            });
        },

        // The caller's subscriptions with the given status. "Current cycle" is the newest billing row.
        async listByStatus(userId: string, status: SubscriptionStatus): Promise<SubscriptionListItem[]> {
            return withUserContext(pool, userId, async (client) => {
                const { rows } = await client.query(
                    `SELECT s.id, s.name, s.category, s.price, s.billing_period, s.subscription_type,
                            s.status, s.auto_renews, p.id AS pm_id, p.type AS pm_type,
                            c.due_date, c.status AS cycle_status
                       FROM subscriptions s
                       JOIN payment_methods p ON p.id = s.payment_method_id AND p.user_id = s.user_id
                       LEFT JOIN LATERAL (
                            SELECT b.due_date, b.status FROM billing b
                             WHERE b.subscription_id = s.id AND b.user_id = s.user_id
                             ORDER BY b.due_date DESC LIMIT 1
                       ) c ON true
                      WHERE s.user_id = $1 AND s.status = $2
                      ORDER BY ${ORDER_BY[status]}`,
                    [userId, status],
                );
                return rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    category: row.category,
                    cost: Number(row.price),
                    billingPeriod: row.billing_period,
                    subscriptionType: row.subscription_type,
                    status: row.status,
                    autoRenews: row.auto_renews,
                    paymentMethod: { id: row.pm_id, type: row.pm_type },
                    currentCycle: row.due_date ? { dueDate: row.due_date, status: row.cycle_status } : null,
                }));
            });
        },
    };
}

export type SubscriptionRepository = ReturnType<typeof createSubscriptionRepository>;
