import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { UnauthorizedError } from "../errors.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

// Guards /api/v1/internal/jobs/*, which Supabase Cron calls (SEC-016). These routes never use the
// user session: only the shared secret in X-Internal-Job-Secret counts. Both values are hashed to
// the same length first, so the comparison takes the same time whatever the input (no timing leak
// of how much of the secret was right), and its length is not revealed either.
export function requireJobSecret(secret: string): RequestHandler {
    const expected = sha256(secret);
    return (req, _res, next) => {
        const given = req.get("x-internal-job-secret");
        if (!given || !timingSafeEqual(sha256(given), expected)) {
            // A wrong secret is a security event (SEC-049): log where it came from, never what was sent.
            console.warn("internal job request rejected", { path: req.baseUrl + req.path, ip: req.ip });
            throw new UnauthorizedError();
        }
        next();
    };
}
