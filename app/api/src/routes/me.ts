import { Router } from "express";
import { z } from "zod";
import { isValidTimeZone } from "../domain/timeZones.js";
import { isValidUnsubscribeToken } from "../domain/unsubscribeToken.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import type { RateLimiters } from "../middleware/rateLimit.js";
import type { ProfileService } from "../services/profileService.js";
import { parse } from "../validation.js";

// Only the time zone (Story 4) and the monthly summary choice (Story 10) can be changed. Strict: the
// email or id can never be sent this way.
const patchBody = z
    .strictObject({
        timeZone: z.string("Enter a time zone").refine(isValidTimeZone, "Unknown time zone").optional(),
        monthlySummary: z.boolean("Must be true or false").optional(),
    })
    .refine((body) => body.timeZone !== undefined || body.monthlySummary !== undefined, "Nothing to change");

// The one-click unsubscribe link (Story 10, RFC 8058): a user id and its signature, in the query.
const unsubscribeQuery = z.strictObject({
    u: z.uuid(),
    t: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

// GET /api/v1/me: the signed-in user's own profile. HTTP layer only: read the request, call one
// service function, shape the response.
export function createMeRouter(profileService: ProfileService, limiters: RateLimiters) {
    const router = Router();

    router.get("/", async (req, res) => {
        // Set by the auth middleware from the verified token; never from the request itself.
        const userId = req.userId;
        if (!userId) throw new UnauthorizedError();
        res.json(await profileService.getProfile(userId));
    });

    // PATCH /api/v1/me: the browser reports the user's time zone, so reminders use their calendar;
    // the settings switch turns the monthly summary on or off.
    router.patch("/", limiters.writes, async (req, res) => {
        const userId = req.userId;
        if (!userId) throw new UnauthorizedError();
        res.json(await profileService.update(userId, parse(patchBody, req.body)));
    });

    return router;
}

// POST /api/v1/email/unsubscribe?u=&t= (Story 10): turns the monthly summary off without signing in.
// Mail apps POST here from their own servers (List-Unsubscribe-Post), with no cookie or Origin, so
// it sits outside the session and CSRF checks; the signature is what authorises it, and it can
// only switch this one email off. GET is not answered: link scanners must not unsubscribe anyone.
export function createUnsubscribeRouter(profileService: ProfileService, limiters: RateLimiters, linkSecret: string) {
    const router = Router();
    router.post("/unsubscribe", limiters.emailLinks, async (req, res) => {
        const result = unsubscribeQuery.safeParse(req.query);
        // One answer for every bad link, whatever is wrong with it.
        if (!result.success || !isValidUnsubscribeToken(linkSecret, result.data.u, result.data.t)) {
            // A security event (SEC-049): where it came from, never the link or signature sent.
            console.warn("unsubscribe link rejected", { requestId: req.requestId, ip: req.ip });
            throw new ValidationError("This unsubscribe link is not valid");
        }
        // A deleted account has no profile: nothing to change, and the answer is the same.
        await profileService.update(result.data.u, { monthlySummary: false }).catch((err: unknown) => {
            if (!(err instanceof NotFoundError)) throw err;
        });
        // An audit record of the change: who and which request, not the signature.
        console.info("monthly summary unsubscribed", { requestId: req.requestId, userId: result.data.u });
        res.json({ unsubscribed: true });
    });
    return router;
}
