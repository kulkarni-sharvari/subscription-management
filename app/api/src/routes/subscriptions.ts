import { Router } from "express";
import { z } from "zod";
import { isValidIsoDate } from "../domain/billingDates.js";
import { UnauthorizedError } from "../errors.js";
import type { RateLimiters } from "../middleware/rateLimit.js";
import type { NewSubscription } from "../repositories/subscriptionRepository.js";
import type { SubscriptionService } from "../services/subscriptionService.js";
import { parse } from "../validation.js";

// Free text a user types: trimmed, length-limited, and free of control characters (line breaks
// and the like), which would let a value forge log lines or email headers.
const text = (label: string, max: number) =>
    z
        .string(`Enter the ${label}`)
        .trim()
        .min(1, `Enter the ${label}`)
        .max(max, `The ${label} must be at most ${max} characters`)
        .regex(/^[^\p{Cc}]*$/u, `The ${label} contains characters that are not allowed`);

// A link must start with http:// or https:// and parse as a URL (SEC-035). javascript:, data: and
// vbscript: addresses fail both checks. An empty field means "no link".
const link = (label: string) =>
    z
        .string()
        .trim()
        .max(2048, `The ${label} must be at most 2048 characters`)
        .transform((value) => (value === "" ? undefined : value))
        .refine(
            (value) => {
                if (value === undefined) return true;
                if (!/^https?:\/\//i.test(value)) return false;
                try {
                    const url = new URL(value);
                    // No embedded credentials (https://user:pass@host).
                    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
                } catch {
                    return false;
                }
            },
            `The ${label} must be a valid http or https address`,
        )
        .optional();

const startDate = z
    .string("Enter the start date")
    .refine(isValidIsoDate, "Enter a valid start date (YYYY-MM-DD)")
    // A sanity range, so absurd years cannot reach date arithmetic or the database.
    .refine((value) => value >= "2000-01-01" && value <= "2100-12-31", "The start date must be between 2000 and 2100");

// Cost is a money amount: positive, at most two decimals, and within what NUMERIC(10,2) can hold.
const cost = z
    .number("Enter the cost")
    .positive("The cost must be greater than 0")
    .max(99_999_999.99, "The cost is too large")
    .refine((value) => Math.round(value * 100) / 100 === value, "The cost can have at most 2 decimal places");

// strictObject: unknown fields are an error, not ignored. status, userId and the like can never be set (SEC-030).
const createBody = z
    .strictObject({
        name: text("subscription name", 100),
        category: text("category", 50),
        subscriptionType: z.enum(["recurring", "one_time"], "Choose recurring or one-time"),
        billingPeriod: z.enum(["monthly", "6_months", "annually"], "Choose monthly, every 6 months or annually").optional(),
        startDate,
        cost,
        paymentMethodId: z.uuid("Choose a payment method"),
        renewalLink: link("renewal link"),
        cancellationLink: link("cancellation link"),
        autoRenews: z.boolean("Say whether it renews automatically"),
    })
    // BR-017: a recurring subscription needs a billing period; a one-time purchase must not have one.
    .superRefine((body, ctx) => {
        if (body.subscriptionType === "recurring" && !body.billingPeriod) {
            ctx.addIssue({ code: "custom", path: ["billingPeriod"], message: "Choose a billing period" });
        }
        if (body.subscriptionType === "one_time" && body.billingPeriod) {
            ctx.addIssue({ code: "custom", path: ["billingPeriod"], message: "A one-time purchase has no billing period" });
        }
    });

const listQuery = z.strictObject({
    status: z.enum(["active", "active-unknown", "inactive"], "status must be active, active-unknown or inactive"),
});

// /api/v1/subscriptions (Story 2). HTTP layer only: validate, call the service, shape the answer.
export function createSubscriptionsRouter(service: SubscriptionService, limiters: RateLimiters) {
    const router = Router();

    router.post("/", limiters.writes, async (req, res) => {
        if (!req.userId) throw new UnauthorizedError();
        const body = parse(createBody, req.body);
        const input: NewSubscription = {
            ...body,
            billingPeriod: body.billingPeriod ?? null,
            renewalLink: body.renewalLink ?? null,
            cancellationLink: body.cancellationLink ?? null,
        };
        res.status(201).json(await service.create(req.userId, input, req.requestId));
    });

    router.get("/", async (req, res) => {
        if (!req.userId) throw new UnauthorizedError();
        const { status } = parse(listQuery, req.query);
        res.json(await service.list(req.userId, status));
    });

    return router;
}
