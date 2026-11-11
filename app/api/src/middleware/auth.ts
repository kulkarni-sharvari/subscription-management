import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { UnauthorizedError } from "../errors.js";

// Makes `req.userId` known to TypeScript. Set only by createAuth, from the verified token's `sub`.
declare module "express-serve-static-core" {
    interface Request {
        userId?: string;
    }
}

export interface AuthDeps {
    // Returns the user id (`sub`) of a valid token. Any problem with the token must throw.
    verifyToken: (token: string) => Promise<string>;
    // True if the account still has a profiles row (SEC-068).
    profileExists: (userId: string) => Promise<boolean>;
}

// Authenticates every request behind it (FR-004, FR-005, SEC-021, SEC-068).
// The user id is taken only from the verified token, never from the body, query or a header.
export function createAuth({ verifyToken, profileExists }: AuthDeps): RequestHandler {
    return async (req, _res, next) => {
        const match = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "");
        if (!match) throw new UnauthorizedError();

        // However verification fails (expired, tampered, wrong audience, key fetch...), the client
        // gets the same bare 401, so it never learns which check failed (SEC-021).
        const userId = await verifyToken(match[1]).catch(() => {
            throw new UnauthorizedError();
        });

        // A still-valid token for a deleted account must not get through (SEC-068).
        if (!(await profileExists(userId))) throw new UnauthorizedError();

        req.userId = userId;
        next();
    };
}

// Verifies a Supabase access token and returns its user id (SEC-021).
export function createTokenVerifier(
    supabaseUrl: string,
    keys?: JWTVerifyGetKey,
): (token: string) => Promise<string> {
    // .origin drops any trailing slash, so the issuer string matches the token's exactly.
    const base = new URL(supabaseUrl).origin;
    const issuer = `${base}/auth/v1`;
    // Built once at startup: jose fetches the public keys when first needed and caches them.
    const keySet = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

    return async (token) => {
        const { payload } = await jwtVerify(token, keySet, {
            // Pinned: the project signs with ECC P-256. The token's own header never picks the
            // algorithm, which is what blocks `alg: none` and algorithm-confusion attacks.
            algorithms: ["ES256"],
            issuer,
            audience: "authenticated",
            // jwtVerify also checks the signature and `exp` (and `nbf` if present).
        });
        // The id is used for the database context next, so require it to be a UUID.
        if (!z.uuid().safeParse(payload.sub).success) throw new Error("invalid subject");
        return payload.sub as string;
    };
}
