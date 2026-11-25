import { Router } from "express";
import { z } from "zod";
import { addDays, daysBetween, isValidIsoDate } from "../domain/billingDates.js";
import { UnauthorizedError, ValidationError } from "../errors.js";
import type { RateLimiters } from "../middleware/rateLimit.js";
import type { AnalyticsRepository } from "../repositories/analyticsRepository.js";
import { parse } from "../validation.js";

// SEC-038: a range of at most 5 years, so one request cannot ask the database to aggregate an
// unbounded history. 5 years of days, plus the leap days in them.
export const MAX_RANGE_DAYS = 5 * 365 + 2;

const date = (label: string) =>
    z
        .string()
        .refine(isValidIsoDate, `${label} must be a date (YYYY-MM-DD)`)
        .refine((value) => value >= "2000-01-01" && value <= "2100-12-31", `${label} must be between 2000 and 2100`);

// strictObject: an unknown query parameter is a 400, not ignored.
const spendingQuery = z.strictObject({ from: date("from").optional(), to: date("to").optional() });

// /api/v1/analytics (Story 9). Read-only, the caller's own data only.
export function createAnalyticsRouter(analytics: Pick<AnalyticsRepository, "spending">, limiters: RateLimiters) {
    const router = Router();

    router.get("/spending", limiters.analytics, async (req, res) => {
        if (!req.userId) throw new UnauthorizedError();
        const query = parse(spendingQuery, req.query);
        // Default: the last 12 months up to today (UTC). The web app always sends both dates.
        const to = query.to ?? new Date().toISOString().slice(0, 10);
        const from = query.from ?? addDays(to, -364);
        if (from > to) throw new ValidationError("from must be on or before to", "from");
        if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new ValidationError("The range can be at most 5 years", "from");
        res.json(await analytics.spending(req.userId, from, to));
    });

    return router;
}
