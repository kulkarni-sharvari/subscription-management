import { Router } from "express";
import { z } from "zod";
import { UnauthorizedError, ValidationError } from "../errors.js";
import type { AuthService } from "../services/authService.js";
import type { SessionCookies } from "../session/cookies.js";

// Trimmed and lower-cased so "Ann@x.com " and "ann@x.com" are the same account.
const email = z
    .string("Enter your email address")
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email address").max(254, "Enter a valid email address"));

const registerBody = z.object({
    email,
    // 14 matches the minimum configured in Supabase. 72 is the most bcrypt (Supabase's hash) uses.
    password: z
        .string("Enter a password")
        .min(14, "Password must be at least 14 characters")
        .max(72, "Password must be at most 72 characters"),
});

// Login only checks that something was sent: the password policy can change, and the
// minimum must never become a way to learn about existing accounts.
const loginBody = z.object({
    email,
    password: z.string("Enter your password").min(1, "Enter your password").max(256),
});

const confirmBody = z.object({
    tokenHash: z.string("Invalid confirmation link").min(1, "Invalid confirmation link").max(512),
});

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
    const result = schema.safeParse(body);
    if (!result.success) {
        const issue = result.error.issues[0];
        throw new ValidationError(issue.message, issue.path.join(".") || undefined);
    }
    return result.data;
}

// /api/v1/auth/*: the only place the browser signs in. Public (no token needed), so the router
// is mounted before the auth middleware. Tokens only ever travel in httpOnly cookies.
export function createAuthRouter(auth: AuthService, cookies: SessionCookies) {
    const router = Router();

    // Sign-up answers are the same for new and existing emails (SEC-024).
    router.post("/register", async (req, res) => {
        const { email, password } = parse(registerBody, req.body);
        await auth.register(email, password);
        res.status(202).json({ message: "Check your email to confirm your account" });
    });

    router.post("/login", async (req, res) => {
        const { email, password } = parse(loginBody, req.body);
        cookies.set(res, await auth.login(email, password));
        res.status(204).end();
    });

    // The confirmation email links to the React app, which posts the token from the link here.
    router.post("/confirm", async (req, res) => {
        const { tokenHash } = parse(confirmBody, req.body);
        cookies.set(res, await auth.confirmEmail(tokenHash));
        res.status(204).end();
    });

    // Trades the refresh cookie for a new pair of cookies (Supabase rotates the refresh token).
    router.post("/refresh", async (req, res) => {
        const refreshToken = cookies.read(req, cookies.names.refresh);
        if (!refreshToken) throw new UnauthorizedError();
        try {
            cookies.set(res, await auth.refresh(refreshToken));
        } catch (err) {
            cookies.clear(res);
            throw err;
        }
        res.status(204).end();
    });

    // Always ends with the cookies cleared, even if Supabase could not be reached.
    router.post("/logout", async (req, res) => {
        const accessToken = cookies.read(req, cookies.names.access);
        const refreshToken = cookies.read(req, cookies.names.refresh);
        if (accessToken && refreshToken) {
            try {
                await auth.logout({ accessToken, refreshToken });
            } catch (err) {
                // Logged for the operator; the user is still signed out of this browser.
                console.error("logout: session revoke failed", { err });
            }
        }
        cookies.clear(res);
        res.status(204).end();
    });

    return router;
}
