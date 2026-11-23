import type pg from "pg";
import { renewalDigestEmail, subscriptionRenewedEmail, subscriptionsAddedEmail, type DigestItem, type OverdueItem } from "../email/templates.js";
import { reserveEmailSlot } from "../repositories/notificationLogRepository.js";
import type { ProfileRepository } from "../repositories/profileRepository.js";
import type { SubscriptionDetail } from "../repositories/subscriptionRepository.js";
import type { EmailService } from "./emailService.js";

// At most this many emails per user per UTC day, of every kind together (SEC-048). A normal day
// is one to three (adds and one digest); the cap stops a loop or abuse long before the provider's
// daily quota (100 on Resend's free plan) is at risk.
export const EMAIL_DAILY_CAP = 10;

// Turns events into emails. Every email passes through here, so the daily cap is enforced in one
// place. The address and the content come from the same user id, so a message can only ever
// carry its owner's data to its owner (SEC-045).
export function createNotificationService(deps: {
    profiles: Pick<ProfileRepository, "findById">;
    email: EmailService;
    // Takes one of the user's email slots for today in its own transaction (as that user).
    reserveSlot: (userId: string) => Promise<boolean>;
}) {
    return {
        // One email for everything one user action added (a single subscription, or an import's batch).
        async subscriptionsAdded(userId: string, subscriptions: SubscriptionDetail[]): Promise<void> {
            if (subscriptions.length === 0) return;
            const profile = await deps.profiles.findById(userId);
            if (!profile) return; // the account no longer exists: send nothing
            if (!(await deps.reserveSlot(userId))) {
                console.warn("email not sent: daily cap reached", { userId, kind: "subscriptions_added" });
                return;
            }
            await deps.email.send({ to: profile.email, ...subscriptionsAddedEmail(subscriptions) });
        },

        // "I renewed" brought a subscription back to active (Story 6): one email for the action.
        async subscriptionRenewed(userId: string, subscription: SubscriptionDetail, payments: number): Promise<void> {
            const profile = await deps.profiles.findById(userId);
            if (!profile) return;
            if (!(await deps.reserveSlot(userId))) {
                console.warn("email not sent: daily cap reached", { userId, kind: "subscription_renewed" });
                return;
            }
            await deps.email.send({ to: profile.email, ...subscriptionRenewedEmail(subscription, payments) });
        },

        // The daily digest ("Needs action" and "Renews soon"), sent inside the reminder job's transaction: the slot is taken with the
        // job's client, so a failed send rolls back the slot together with the job's log row.
        // "capped" means nothing was sent because the user reached today's cap.
        async renewalDigest(
            client: pg.PoolClient,
            recipient: { userId: string; email: string },
            items: DigestItem[],
            overdue: OverdueItem[] = [],
        ): Promise<"sent" | "capped"> {
            if (!(await reserveEmailSlot(client, recipient.userId, EMAIL_DAILY_CAP))) return "capped";
            await deps.email.send({ to: recipient.email, ...renewalDigestEmail(items, overdue) });
            return "sent";
        },
    };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
