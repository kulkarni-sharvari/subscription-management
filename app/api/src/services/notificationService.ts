import { subscriptionsAddedEmail } from "../email/templates.js";
import type { ProfileRepository } from "../repositories/profileRepository.js";
import type { SubscriptionDetail } from "../repositories/subscriptionRepository.js";
import type { EmailService } from "./emailService.js";

// Turns events into emails. The address and the content are both looked up from the same userId
// inside one function, so a message can only ever carry its owner's data to its owner (SEC-045).
export function createNotificationService(deps: { profiles: Pick<ProfileRepository, "findById">; email: EmailService }) {
    return {
        // One email for everything one user action added (a single subscription, or an import's batch).
        async subscriptionsAdded(userId: string, subscriptions: SubscriptionDetail[]): Promise<void> {
            if (subscriptions.length === 0) return;
            const profile = await deps.profiles.findById(userId);
            if (!profile) return; // the account no longer exists: send nothing
            await deps.email.send({ to: profile.email, ...subscriptionsAddedEmail(subscriptions) });
        },
    };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
