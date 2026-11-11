import type { RequestHandler } from "express";
import { ForbiddenError } from "../errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF defence for cookie sessions. Browsers always send an Origin header on a POST/PUT/PATCH/
// DELETE and page JavaScript cannot change it, so a request from any other site is rejected.
// This is a second layer on top of the SameSite=Strict cookies.
export function requireSameOrigin(allowedOrigin: string): RequestHandler {
    return (req, _res, next) => {
        if (!SAFE_METHODS.has(req.method) && req.get("origin") !== allowedOrigin) {
            throw new ForbiddenError();
        }
        next();
    };
}
