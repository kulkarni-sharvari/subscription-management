import { addBillingPeriod } from "../domain/billingDates.js";
import type { NewSubscription, SubscriptionRepository, SubscriptionStatus } from "../repositories/subscriptionRepository.js";
import type { NotificationService } from "./notificationService.js";

export function createSubscriptionService(deps: {
    subscriptions: SubscriptionRepository;
    notifications: Pick<NotificationService, "subscriptionsAdded">;
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

        list: (userId: string, status: SubscriptionStatus) => deps.subscriptions.listByStatus(userId, status),
    };
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>;
