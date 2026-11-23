import { addBillingPeriod } from "../domain/billingDates.js";
import { NotFoundError } from "../errors.js";
import type { NewSubscription, PageKey, RenewalInput, SubscriptionEdit, SubscriptionRepository, SubscriptionStatus } from "../repositories/subscriptionRepository.js";
import type { NotificationService } from "./notificationService.js";

export function createSubscriptionService(deps: {
    subscriptions: SubscriptionRepository;
    notifications: Pick<NotificationService, "subscriptionsAdded" | "subscriptionRenewed" | "subscriptionCancelled">;
}) {
    return {
        // FR-010 to FR-013, FR-044. The status is never an input: a new subscription is always active.
        async create(userId: string, input: NewSubscription, requestId: string) {
            // BR-003: the first due date is derived, never typed in. A recurring subscription is due one period after it starts; a one-time purchase has no period and is due on its start date.
            const dueDate =
                input.subscriptionType === "recurring" && input.billingPeriod
                    ? addBillingPeriod(input.startDate, input.billingPeriod)
                    : input.startDate;

            const created = await deps.subscriptions.createWithFirstBilling(userId, input, { dueDate, requestId });

            // The data is saved. The email is best effort: it is not awaited and a failure is only
            // logged (no address, no message text), so it can never undo or fail the save.
            deps.notifications.subscriptionsAdded(userId, [created]).catch((err: unknown) => {
                console.error("subscription-added email failed", { userId, reason: err instanceof Error ? err.message : "unknown" });
            });
            return created;
        },

        list: (userId: string, status: SubscriptionStatus, page: { limit: number; after?: PageKey }) =>
            deps.subscriptions.listByStatus(userId, status, page),

        // FR-021. Someone else's subscription gets the same 404 as one that does not exist (SEC-031).
        async get(userId: string, id: string) {
            const found = await deps.subscriptions.findById(userId, id);
            if (!found) throw new NotFoundError();
            return found;
        },

        // Story 8, FR-030: edit details. No email: an edit never changes the status.
        update: (userId: string, id: string, edit: SubscriptionEdit, expectedUpdatedAt: string) =>
            deps.subscriptions.update(userId, id, edit, expectedUpdatedAt),

        // Story 7, FR-032: "I cancelled". Best-effort email, as above; a refused (409) or unknown
        // (404) request sends nothing.
        async cancel(userId: string, id: string) {
            const cancelled = await deps.subscriptions.cancel(userId, id);
            deps.notifications.subscriptionCancelled(userId, cancelled).catch((err: unknown) => {
                console.error("subscription-cancelled email failed", { userId, reason: err instanceof Error ? err.message : "unknown" });
            });
            return cancelled;
        },

        // Story 6, FR-031: "I renewed". The email goes out only when the status changed, and never
        // for a repeated request; like on create it is best effort and cannot undo the renewal.
        async renew(userId: string, id: string, input: RenewalInput, ctx: { requestId: string; idempotencyKey: string }) {
            const result = await deps.subscriptions.renew(userId, id, input, ctx);
            if (result.statusChanged && !result.replayed) {
                deps.notifications.subscriptionRenewed(userId, result.subscription, result.payments).catch((err: unknown) => {
                    console.error("subscription-renewed email failed", { userId, reason: err instanceof Error ? err.message : "unknown" });
                });
            }
            return result.subscription;
        },
    };
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>;
