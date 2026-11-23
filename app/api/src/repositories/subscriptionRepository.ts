import type pg from "pg";
import { z } from "zod";
import { withUserContext } from "../db/pool.js";
import { isValidIsoDate, type BillingPeriod } from "../domain/billingDates.js";
import { planRenewal, renewalInfo, RenewalRefused, type RenewalChoice, type RenewalInfo } from "../domain/renewal.js";
import { isValidTimeZone, localDateAndHour } from "../domain/timeZones.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
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
    // The day the user recorded a cancellation (Story 7); null unless inactive.
    cancelledOn: string | null;
    // Whether "I renewed" applies now, and what it would record (Story 6). Set on reads of one
    // subscription; absent right after creating one.
    renewal?: RenewalInfo;
}

// What "I renewed" may change (Story 6). Both apply to the new cycles and going forward.
export interface RenewalInput {
    cost?: number;
    paymentMethodId?: string;
    billingPeriod?: BillingPeriod;
    choice: RenewalChoice;
}

export interface RenewalResult {
    subscription: SubscriptionDetail;
    // active-unknown -> active (an early renewal leaves it active and changes nothing visible).
    statusChanged: boolean;
    // The same Idempotency-Key was used before: nothing new was recorded (SEC-041).
    replayed: boolean;
    // Paid cycles this request added.
    payments: number;
}

// The user's local date, from their stored time zone (UTC if it is somehow not a valid zone).
const localToday = (timeZone: string) => localDateAndHour(new Date(), isValidTimeZone(timeZone) ? timeZone : "UTC").date;

// Where a page of the list stops: the sort key of its last row. Every sort ends with the id, so
// the order is total (two rows never tie) and no row is skipped or repeated between pages.
// "infinity" stands for "no billing cycle yet", which sorts last.
export interface PageKey {
    due: string;
    name: string;
    id: string;
}

const cursorSchema = z.strictObject({
    due: z.union([z.literal("infinity"), z.string().refine(isValidIsoDate)]),
    name: z.string().min(1).max(100),
    id: z.uuid(),
});

// The cursor is opaque to the client (base64url of the key). It is not signed: a changed cursor
// only moves the caller's own position in the caller's own rows, which the user_id filter and
// row-level security still limit. It is validated strictly, and only ever passed as a parameter.
export function encodeCursor(key: PageKey): string {
    return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor(text: string): PageKey | null {
    try {
        const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

// Fixed SQL text per status, chosen from this map: a request value is never put into SQL (SEC-033).
// "after" is the keyset condition for the next page; its values arrive as parameters from $4.
interface Sort {
    order: string;
    after: string;
    params: (key: PageKey) => unknown[];
}
const BY_DUE: Sort = {
    order: "COALESCE(c.due_date, 'infinity'::date), s.name, s.id",
    after: "AND (COALESCE(c.due_date, 'infinity'::date), s.name, s.id) > ($4::date, $5, $6::uuid)",
    params: (key) => [key.due, key.name, key.id],
};
const BY_NAME: Sort = {
    order: "s.name, s.id",
    after: "AND (s.name, s.id) > ($4, $5::uuid)",
    params: (key) => [key.name, key.id],
};
const SORT: Record<SubscriptionStatus, Sort> = {
    active: BY_DUE,
    "active-unknown": BY_DUE, // the oldest missed renewal first: the most urgent to deal with
    inactive: BY_NAME,
};

const LIST_COLUMNS = `s.id, s.name, s.category, s.price, s.billing_period, s.subscription_type,
       s.status, s.auto_renews, p.id AS pm_id, p.type AS pm_type, c.due_date, c.status AS cycle_status`;
// "Current cycle" is the newest billing row. The payment method join also matches user_id, so a row can never show another user's method.
const FROM_SUBSCRIPTIONS = `FROM subscriptions s
       JOIN payment_methods p ON p.id = s.payment_method_id AND p.user_id = s.user_id
       LEFT JOIN LATERAL (
            SELECT b.due_date, b.status FROM billing b
             WHERE b.subscription_id = s.id AND b.user_id = s.user_id
             ORDER BY b.due_date DESC LIMIT 1
       ) c ON true`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toListItem(row: any): SubscriptionListItem {
    return {
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
    };
}

export interface SubscriptionPage {
    items: SubscriptionListItem[];
    // Pass back as ?cursor= for the next page; null on the last page.
    nextCursor: string | null;
}

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
                    cancelledOn: null,
                    createdAt: created.createdAt,
                    updatedAt: created.updatedAt,
                };
            });
        },

        // One page of the caller's subscriptions with the given status. One extra row is read to
        // learn whether another page exists.
        async listByStatus(userId: string, status: SubscriptionStatus, page: { limit: number; after?: PageKey }): Promise<SubscriptionPage> {
            const sort = SORT[status];
            return withUserContext(pool, userId, async (client) => {
                const { rows } = await client.query(
                    `SELECT ${LIST_COLUMNS} ${FROM_SUBSCRIPTIONS}
                      WHERE s.user_id = $1 AND s.status = $2 ${page.after ? sort.after : ""}
                      ORDER BY ${sort.order}
                      LIMIT $3`,
                    [userId, status, page.limit + 1, ...(page.after ? sort.params(page.after) : [])],
                );
                const last = rows.length > page.limit ? rows[page.limit - 1] : null;
                return {
                    items: rows.slice(0, page.limit).map(toListItem),
                    nextCursor: last ? encodeCursor({ due: last.due_date ?? "infinity", name: last.name, id: last.id }) : null,
                };
            });
        },

        // One of the caller's subscriptions, or null. Someone else's id and a missing id look the same.
        async findById(userId: string, id: string): Promise<SubscriptionDetail | null> {
            return withUserContext(pool, userId, (client) => selectDetail(client, userId, id));
        },

        // Story 7, FR-032: "I cancelled". The subscription becomes inactive and is kept (BR-009);
        // no billing row changes: a lapsed cycle stays due (unpaid), a current one stays paid.
        // The row is locked, so a double click or a lapse at the same moment waits; the second
        // click then finds it inactive (409) and nothing is sent twice.
        async cancel(userId: string, id: string): Promise<SubscriptionDetail> {
            return withUserContext(pool, userId, async (client) => {
                const locked = await client.query(
                    `SELECT s.status, p.time_zone FROM subscriptions s JOIN profiles p ON p.id = s.user_id
                      WHERE s.id = $1 AND s.user_id = $2 FOR UPDATE OF s`,
                    [id, userId],
                );
                if (locked.rowCount !== 1) throw new NotFoundError();
                if (locked.rows[0].status === "inactive") throw new ConflictError("This subscription is already cancelled");
                await client.query(
                    `UPDATE subscriptions SET status = 'inactive', cancelled_on = $3::date, updated_at = now()
                      WHERE id = $1 AND user_id = $2`,
                    [id, userId, localToday(locked.rows[0].time_zone)],
                );
                return (await selectDetail(client, userId, id))!;
            });
        },

        // Story 6, FR-031: "I renewed". One transaction with the subscription row locked, so a
        // double submit or a lapse running at the same moment waits and then sees the new state.
        async renew(userId: string, id: string, input: RenewalInput, ctx: { requestId: string; idempotencyKey: string }): Promise<RenewalResult> {
            return withUserContext(pool, userId, async (client) => {
                const locked = await client.query(
                    `SELECT s.status, s.subscription_type, s.billing_period, s.price, s.payment_method_id, p.time_zone
                       FROM subscriptions s JOIN profiles p ON p.id = s.user_id
                      WHERE s.id = $1 AND s.user_id = $2
                      FOR UPDATE OF s`,
                    [id, userId],
                );
                if (locked.rowCount !== 1) throw new NotFoundError();
                const sub = locked.rows[0];

                // A repeated request (same key) gets the current state back and records nothing (SEC-041).
                const seen = await client.query("SELECT 1 FROM billing WHERE subscription_id = $1 AND idempotency_key = $2", [id, ctx.idempotencyKey]);
                if (seen.rowCount === 1) {
                    return { subscription: (await selectDetail(client, userId, id))!, statusChanged: false, replayed: true, payments: 0 };
                }

                const current = await client.query("SELECT due_date FROM billing WHERE subscription_id = $1 ORDER BY due_date DESC LIMIT 1", [id]);
                if (current.rowCount !== 1) throw new ConflictError("This subscription has no billing cycle to renew");

                let plan;
                try {
                    plan = planRenewal(
                        {
                            status: sub.status,
                            subscriptionType: sub.subscription_type,
                            billingPeriod: sub.billing_period,
                            currentDue: current.rows[0].due_date,
                            today: localToday(sub.time_zone),
                        },
                        input.choice,
                        input.billingPeriod,
                    );
                } catch (err) {
                    if (err instanceof RenewalRefused) {
                        throw err.kind === "conflict" ? new ConflictError(err.message) : new ValidationError(err.message, err.field);
                    }
                    throw err;
                }

                // A new payment method must be the caller's own and active, like on create.
                if (input.paymentMethodId !== undefined) {
                    const method = await client.query("SELECT 1 FROM payment_methods WHERE id = $1 AND user_id = $2 AND is_active", [input.paymentMethodId, userId]);
                    if (method.rowCount !== 1) throw new ValidationError("Choose one of your active payment methods", "paymentMethodId");
                }
                // What changed applies going forward: catch-up cycles keep the old values.
                const price = input.cost !== undefined ? input.cost.toFixed(2) : sub.price;
                const paymentMethodId = input.paymentMethodId ?? sub.payment_method_id;

                // New rows only; earlier cycles, lapsed or not, are never touched (BR-005, BR-021).
                // The key goes on the first row; UNIQUE (subscription_id, due_date) backs up a
                // second request that carries a different key.
                for (const [i, cycle] of plan.cycles.entries()) {
                    await client.query(
                        `INSERT INTO billing (subscription_id, user_id, amount, payment_method_id, status, due_date, created_by, request_id, idempotency_key)
                         VALUES ($1, $2, $3, $4, 'paid', $5, 'user', $6, $7)`,
                        [
                            id, userId,
                            cycle.catchUp ? sub.price : price,
                            cycle.catchUp ? sub.payment_method_id : paymentMethodId,
                            cycle.dueDate, ctx.requestId, i === 0 ? ctx.idempotencyKey : null,
                        ],
                    );
                }
                await client.query(
                    `UPDATE subscriptions
                        SET status = 'active', price = $3, payment_method_id = $4, billing_period = $5,
                            start_date = COALESCE($6::date, start_date), updated_at = now()
                      WHERE id = $1 AND user_id = $2`,
                    [id, userId, price, paymentMethodId, input.billingPeriod ?? sub.billing_period, plan.newStartDate ?? null],
                );
                return {
                    subscription: (await selectDetail(client, userId, id))!,
                    statusChanged: sub.status !== "active",
                    replayed: false,
                    payments: plan.cycles.length,
                };
            });
        },
    };
}

export type SubscriptionRepository = ReturnType<typeof createSubscriptionRepository>;

// One of the caller's subscriptions with what "I renewed" would do, or null. Someone else's id and
// a missing id look the same. Runs inside the caller's user-context transaction.
async function selectDetail(client: pg.PoolClient, userId: string, id: string): Promise<SubscriptionDetail | null> {
    const { rows } = await client.query(
        `SELECT ${LIST_COLUMNS}, s.renewal_link, s.cancellation_link, s.start_date, s.created_at, s.updated_at, s.cancelled_on, u.time_zone
           ${FROM_SUBSCRIPTIONS}
           JOIN profiles u ON u.id = s.user_id
          WHERE s.id = $1 AND s.user_id = $2`,
        [id, userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const item = toListItem(row);
    return {
        ...item,
        renewalLink: row.renewal_link,
        cancellationLink: row.cancellation_link,
        startDate: row.start_date,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        cancelledOn: row.cancelled_on,
        ...(item.currentCycle && {
            renewal: renewalInfo({
                status: item.status,
                subscriptionType: item.subscriptionType,
                billingPeriod: item.billingPeriod,
                currentDue: item.currentCycle.dueDate,
                today: localToday(row.time_zone),
            }),
        }),
    };
}

// One subscription that may need a renewal reminder, with its owner's address and time zone.
export interface ReminderCandidate {
    userId: string;
    email: string;
    timeZone: string;
    subscriptionId: string;
    name: string;
    cost: number;
    billingPeriod: BillingPeriod;
    renewalLink: string | null;
    paymentMethodType: PaymentMethodType;
    dueDate: string;
    // "active": renews on dueDate. "active-unknown": dueDate passed with nothing recorded (Story 5).
    status: "active" | "active-unknown";
}

// CROSS-USER, for the digest job only (run with the job_runner role, never app_user). Every
// active recurring subscription whose current cycle is paid and due between the two dates, and
// every active-unknown one whose current cycle lapsed (due), however long ago.
export async function findReminderCandidatesForAllUsers(
    db: Pick<pg.Pool, "query">,
    dueFrom: string,
    dueTo: string,
): Promise<ReminderCandidate[]> {
    const { rows } = await db.query(
        `SELECT p.id AS user_id, p.email, p.time_zone, s.id, s.name, s.price, s.billing_period, s.status,
                s.renewal_link, pm.type AS pm_type, c.due_date
           FROM subscriptions s
           JOIN profiles p ON p.id = s.user_id
           JOIN payment_methods pm ON pm.id = s.payment_method_id AND pm.user_id = s.user_id
           JOIN LATERAL (
                SELECT b.due_date, b.status FROM billing b
                 WHERE b.subscription_id = s.id AND b.user_id = s.user_id
                 ORDER BY b.due_date DESC LIMIT 1
           ) c ON true
          WHERE s.subscription_type = 'recurring'
            AND ((s.status = 'active' AND c.status = 'paid' AND c.due_date BETWEEN $1::date AND $2::date)
              OR (s.status = 'active-unknown' AND c.status = 'due'))
          ORDER BY p.id, c.due_date, s.name, s.id`,
        [dueFrom, dueTo],
    );
    return rows.map((row) => ({
        userId: row.user_id,
        email: row.email,
        timeZone: row.time_zone,
        subscriptionId: row.id,
        name: row.name,
        cost: Number(row.price),
        billingPeriod: row.billing_period,
        renewalLink: row.renewal_link,
        paymentMethodType: row.pm_type,
        dueDate: row.due_date,
        status: row.status,
    }));
}

// A user who has at least one active recurring subscription whose current cycle is still paid
// and was due on or before the given date. The overdue job works out per user (in their own
// time zone) whether that date has really passed for them.
export interface OverdueUser {
    userId: string;
    email: string;
    timeZone: string;
    // The earliest such due date, so the job can skip users whose local date has not passed it yet.
    earliestDueDate: string;
}

// CROSS-USER, for the overdue job only (job_runner). Read-only: finds who might need a lapse.
export async function findUsersWithOverdueForAllUsers(db: Pick<pg.Pool, "query">, dueOnOrBefore: string): Promise<OverdueUser[]> {
    const { rows } = await db.query(
        `SELECT p.id AS user_id, p.email, p.time_zone, MIN(c.due_date) AS earliest_due
           FROM subscriptions s
           JOIN profiles p ON p.id = s.user_id
           JOIN LATERAL (
                SELECT b.due_date, b.status FROM billing b
                 WHERE b.subscription_id = s.id AND b.user_id = s.user_id
                 ORDER BY b.due_date DESC LIMIT 1
           ) c ON true
          WHERE s.status = 'active' AND s.subscription_type = 'recurring' AND c.status = 'paid'
            AND c.due_date <= $1::date
          GROUP BY p.id, p.email, p.time_zone
          ORDER BY p.id`,
        [dueOnOrBefore],
    );
    return rows.map((row) => ({ userId: row.user_id, email: row.email, timeZone: row.time_zone, earliestDueDate: row.earliest_due }));
}

// One subscription that just lapsed, as shown in the status-change email.
export interface LapsedSubscription {
    subscriptionId: string;
    name: string;
    cost: number;
    billingPeriod: BillingPeriod;
    dueDate: string;
    renewalLink: string | null;
}

// FR-033, FR-045, BR-006: for one user, every active recurring subscription whose current cycle
// is paid and due before `localToday` becomes active-unknown, and that cycle becomes due. One
// statement inside the caller's transaction: the rows are locked first (FOR UPDATE), and the
// conditions are checked again at that moment, so a renewal recorded at the same time wins and a
// second run finds nothing left to do. Returns only the subscriptions this call changed.
export async function lapseOverdueForUser(client: pg.PoolClient, userId: string, localToday: string): Promise<LapsedSubscription[]> {
    const { rows } = await client.query(
        `WITH lapsed AS (
              SELECT s.id, s.name, s.price, s.billing_period, s.renewal_link, c.transaction_id, c.due_date
                FROM subscriptions s
                JOIN LATERAL (
                     SELECT b.transaction_id, b.due_date, b.status FROM billing b
                      WHERE b.subscription_id = s.id AND b.user_id = s.user_id
                      ORDER BY b.due_date DESC LIMIT 1
                ) c ON true
               WHERE s.user_id = $1 AND s.status = 'active' AND s.subscription_type = 'recurring'
                 AND c.status = 'paid' AND c.due_date < $2::date
                 FOR UPDATE OF s
         ), cycles AS (
              UPDATE billing b SET status = 'due', updated_at = now()
                FROM lapsed l
               WHERE b.transaction_id = l.transaction_id AND b.status = 'paid'
         )
         UPDATE subscriptions s SET status = 'active-unknown', updated_at = now()
           FROM lapsed l
          WHERE s.id = l.id
         RETURNING l.id, l.name, l.price, l.billing_period, l.renewal_link, l.due_date`,
        [userId, localToday],
    );
    return rows
        .map((row) => ({
            subscriptionId: row.id,
            name: row.name,
            cost: Number(row.price),
            billingPeriod: row.billing_period,
            dueDate: row.due_date,
            renewalLink: row.renewal_link,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name) || a.subscriptionId.localeCompare(b.subscriptionId));
}
