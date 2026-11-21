import { Router } from "express";
import { z } from "zod";
import { isValidTimeZone } from "../domain/timeZones.js";
import { UnauthorizedError } from "../errors.js";
import type { RateLimiters } from "../middleware/rateLimit.js";
import type { ProfileService } from "../services/profileService.js";
import { parse } from "../validation.js";

// Only the time zone can be changed, and only to a zone the runtime knows (Story 4). Strict: the
// email or id can never be sent this way.
const patchBody = z.strictObject({
    timeZone: z.string("Enter a time zone").refine(isValidTimeZone, "Unknown time zone"),
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

    // PATCH /api/v1/me: the browser reports the user's time zone, so reminders use their calendar.
    router.patch("/", limiters.writes, async (req, res) => {
        const userId = req.userId;
        if (!userId) throw new UnauthorizedError();
        const { timeZone } = parse(patchBody, req.body);
        res.json(await profileService.setTimeZone(userId, timeZone));
    });

    return router;
}
