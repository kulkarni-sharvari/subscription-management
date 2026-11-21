import { Router } from "express";
import type { SendRemindersJob } from "../jobs/sendReminders.js";
import { NotFoundError } from "../errors.js";
import { requireJobSecret } from "../middleware/internalAuth.js";
import type { RateLimiters } from "../middleware/rateLimit.js";

// /api/v1/internal/jobs: called by Supabase Cron (or `npm run job:reminders` in development),
// never by the browser. Mounted outside the user router, so no cookie, CSRF check or user limit
// applies; the shared secret is the only way in. The answer is counts only, no personal data.
export function createInternalJobsRouter(deps: { secret: string; sendReminders: Pick<SendRemindersJob, "run">; limiters: RateLimiters }) {
    const router = Router();
    // Counts failed attempts per address, so the secret cannot be guessed at speed.
    router.use(deps.limiters.jobAuthFailures);
    router.use(requireJobSecret(deps.secret));

    router.post("/send-reminders", async (_req, res) => {
        res.json(await deps.sendReminders.run());
    });

    // An unknown job, after a correct secret, is a 404 here rather than falling through to the user routes.
    router.use((_req, _res, next) => next(new NotFoundError()));
    return router;
}
