import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
    interface Request {
        requestId: string;
    }
}

// Gives every request an id that is generated here, never taken from the client (SEC-043).
// It is stored with the billing rows a request creates and returned in X-Request-Id, so one
// request can be followed through the logs, the database and a support message.
export const requestId: RequestHandler = (req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
};
