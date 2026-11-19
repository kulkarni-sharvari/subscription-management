import { Router } from "express";
import { z } from "zod";
import { UnauthorizedError } from "../errors.js";
import type { RateLimiters } from "../middleware/rateLimit.js";
import type { PaymentMethodService } from "../services/paymentMethodService.js";
import { parse } from "../validation.js";

// .strict() rejects any field not listed, so a client cannot smuggle in userId, isActive and so on (SEC-030).
const createBody = z.strictObject({
    type: z.enum(["credit_card", "debit_card", "apple_pay"], "Choose credit card, debit card or Apple Pay"),
});

const listQuery = z.strictObject({
    activeOnly: z.enum(["true", "false"], "activeOnly must be true or false").default("true"),
});

// /api/v1/payment-methods (FR-041, FR-043). HTTP layer only; the user id is the verified one.
export function createPaymentMethodsRouter(service: PaymentMethodService, limiters: RateLimiters) {
    const router = Router();

    router.post("/", limiters.writes, async (req, res) => {
        if (!req.userId) throw new UnauthorizedError();
        const { type } = parse(createBody, req.body);
        res.status(201).json(await service.create(req.userId, type));
    });

    router.get("/", async (req, res) => {
        if (!req.userId) throw new UnauthorizedError();
        const { activeOnly } = parse(listQuery, req.query);
        res.json(await service.list(req.userId, activeOnly === "true"));
    });

    return router;
}
