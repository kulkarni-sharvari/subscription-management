import type { CookieOptions, Request, Response } from "express";

// What a successful sign-in, confirmation or refresh hands back; the cookies are made from it.
export interface AuthSession {
    accessToken: string;
    refreshToken: string;
    // Seconds until the access token expires.
    expiresIn: number;
}

// The refresh cookie lives this long after its last use, so an unused session ends after 7 days.
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The session lives in httpOnly cookies, so page JavaScript (and therefore XSS) can never read a token. Built once at startup. `secure` must be true in production (HTTPS only).
export function createSessionCookies(secure: boolean) {
    // The __Secure- prefix makes browsers refuse the cookie unless it was set over HTTPS.
    const prefix = secure ? "__Secure-" : "";
    const names = { access: `${prefix}sm_access`, refresh: `${prefix}sm_refresh` };

    // SameSite=Strict: the browser never sends these cookies on a cross-site request (CSRF).
    const base: CookieOptions = { httpOnly: true, secure, sameSite: "strict" };
    // The access cookie goes to every API call; the refresh cookie only to the auth endpoints,
    // so the long-lived token is exposed to as few requests as possible.
    const accessOptions: CookieOptions = { ...base, path: "/api" };
    const refreshOptions: CookieOptions = { ...base, path: "/api/v1/auth" };

    return {
        names,
        set(res: Response, session: AuthSession) {
            res.cookie(names.access, session.accessToken, {
                ...accessOptions,
                maxAge: session.expiresIn * 1000,
            });
            res.cookie(names.refresh, session.refreshToken, {
                ...refreshOptions,
                maxAge: REFRESH_MAX_AGE_MS,
            });
        },
        clear(res: Response) {
            // The path (and flags) must match the ones used to set the cookie, or it is not removed.
            res.clearCookie(names.access, accessOptions);
            res.clearCookie(names.refresh, refreshOptions);
        },
        // Cookie values are only ever strings; anything else (cookie-parser can return objects) is "absent".
        read(req: Request, name: string): string | undefined {
            const value: unknown = req.cookies?.[name];
            return typeof value === "string" && value.length > 0 ? value : undefined;
        },
    };
}

export type SessionCookies = ReturnType<typeof createSessionCookies>;
