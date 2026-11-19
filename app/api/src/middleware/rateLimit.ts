import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { RateLimitedError } from "../errors.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface RateLimitConfig {
    // Any signed-in request, per user.
    perUser: { limit: number; windowMs: number };
    writes: { limit: number; windowMs: number };
    login: { limit: number; windowMs: number };
    register: { limit: number; windowMs: number };
    session: { limit: number; windowMs: number };
}

// Sized from a measurement against the real database, not guessed: one database round trip is
// about 20 ms, so a request (two transactions of four round trips each) holds a connection for
// roughly 200 ms, and a pool of 10 serves about 50 requests per second in total. One user at
// 120 requests a minute is 2 per second, so the limits keep any single account from taking a
// meaningful share, while the pool's own wait limit (db/pool.ts) protects the API as a whole.
export const defaultRateLimits: RateLimitConfig = {
    perUser: { limit: 120, windowMs: MINUTE },
    writes: { limit: 60, windowMs: HOUR },
    login: { limit: 10, windowMs: 15 * MINUTE },
    register: { limit: 5, windowMs: HOUR },
    session: { limit: 30, windowMs: 15 * MINUTE },
};

type Window = { limit: number; windowMs: number };

function limiter(window: Window, key: (req: Request) => string): RequestHandler {
    return rateLimit({
        ...window,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        keyGenerator: key,
        handler: (_req, _res, next) => next(new RateLimitedError()),
        // The key function is ours and handles IPv6, so skip the library's own check of it.
        validate: { keyGeneratorIpFallback: false },
    });
}

// Counted per signed-in user. Only mount it after the auth middleware has set req.userId.
const byUser = (req: Request) => req.userId ?? "anonymous";
// Counted per client address; IPv6 addresses are reduced to their /56 network so a client cannot
// dodge the limit by rotating addresses in its own range.
const byIp = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

export function createRateLimiters(config: RateLimitConfig = defaultRateLimits) {
    return {
        perUser: limiter(config.perUser, byUser),
        writes: limiter(config.writes, byUser),
        login: limiter(config.login, byIp),
        register: limiter(config.register, byIp),
        session: limiter(config.session, byIp),
    };
}

export type RateLimiters = ReturnType<typeof createRateLimiters>;
