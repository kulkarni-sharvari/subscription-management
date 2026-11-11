import { Router } from "express";
import { UnauthorizedError } from "../errors.js";
import type { ProfileService } from "../services/profileService.js";

// GET /api/v1/me: the signed-in user's own profile. HTTP layer only: read the request, call one
// service function, shape the response.
export function createMeRouter(profileService: ProfileService) {
    const router = Router();

    router.get("/", async (req, res) => {
        // Set by the auth middleware from the verified token; never from the request itself.
        const userId = req.userId;
        if (!userId) throw new UnauthorizedError();
        res.json(await profileService.getProfile(userId));
    });

    return router;
}
