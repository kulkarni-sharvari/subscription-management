import { Router } from "express";
import type { SendMonthlySummaryJob } from "../jobs/sendMonthlySummary.js";
import type { SendRemindersJob } from "../jobs/sendReminders.js";
import type { TransitionOverdueJob } from "../jobs/transitionOverdue.js";
import { NotFoundError } from "../errors.js";
import { requireJobSecret } from "../middleware/internalAuth.js";
import type { RateLimiters } from "../middleware/rateLimit.js";

// /api/v1/internal/jobs: called by Supabase Cron (or the `npm run job:*` scripts in development),
// never by the browser. Mounted outside the user router, so no cookie, CSRF check or user limit
// applies; the shared secret is the only way in. The answer is counts only, no personal data.
export function createInternalJobsRouter(deps: {
    secret: string;
    sendReminders: Pick<SendRemindersJob, "run">;
    transitionOverdue: Pick<TransitionOverdueJob, "run">;
    sendMonthlySummary: Pick<SendMonthlySummaryJob, "run">;
    limiters: RateLimiters;
}) {
    const router = Router();
    // Counts failed attempts per address, so the secret cannot be guessed at speed.
    router.use(deps.limiters.jobAuthFailures);
    router.use(requireJobSecret(deps.secret));

    router.post("/send-reminders", async (_req, res) => {
        res.json(await deps.sendReminders.run());
    });

    // Story 5: lapse subscriptions whose renewal date has ended with no outcome recorded.
    router.post("/transition-overdue", async (_req, res) => {
        res.json(await deps.transitionOverdue.run());
    });

    // Story 10: the monthly summary, on the 1st of each user's month.
    router.post("/send-monthly-summary", async (_req, res) => {
        res.json(await deps.sendMonthlySummary.run());
    });

    // An unknown job, after a correct secret, is a 404 here rather than falling through to the user routes.
    router.use((_req, _res, next) => next(new NotFoundError()));
    return router;
}
