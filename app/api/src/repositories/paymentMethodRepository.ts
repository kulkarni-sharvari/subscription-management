import type pg from "pg";
import { withUserContext } from "../db/pool.js";

export type PaymentMethodType = "credit_card" | "debit_card" | "apple_pay";

export interface PaymentMethod {
    id: string;
    type: PaymentMethodType;
    isActive: boolean;
    createdAt: Date;
}

const COLUMNS = `id, type, is_active AS "isActive", created_at AS "createdAt"`;

// Every query filters on user_id as well as running under row-level security: two layers, so a
// mistake in one is caught by the other (SEC-028).
export function createPaymentMethodRepository(pool: pg.Pool) {
    return {
        async create(userId: string, type: PaymentMethodType): Promise<PaymentMethod> {
            return withUserContext(pool, userId, async (client) => {
                const { rows } = await client.query(
                    `INSERT INTO payment_methods (user_id, type) VALUES ($1, $2) RETURNING ${COLUMNS}`,
                    [userId, type],
                );
                return rows[0];
            });
        },

        async list(userId: string, activeOnly: boolean): Promise<PaymentMethod[]> {
            return withUserContext(pool, userId, async (client) => {
                // The two queries are fixed text; nothing from the request is placed into the SQL.
                const sql = activeOnly
                    ? `SELECT ${COLUMNS} FROM payment_methods WHERE user_id = $1 AND is_active ORDER BY created_at`
                    : `SELECT ${COLUMNS} FROM payment_methods WHERE user_id = $1 ORDER BY created_at`;
                const { rows } = await client.query(sql, [userId]);
                return rows;
            });
        },
    };
}

export type PaymentMethodRepository = ReturnType<typeof createPaymentMethodRepository>;
