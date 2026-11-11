import { createClient, type AuthError, type Session } from "@supabase/supabase-js";
import { AppError, UnauthorizedError, ValidationError } from "../errors.js";
import type { AuthSession } from "../session/cookies.js";

export interface AuthService {
    // Always completes the same way for a new and an already-registered email (SEC-024).
    register(email: string, password: string): Promise<void>;
    login(email: string, password: string): Promise<AuthSession>;
    // Completes sign-up from the link in the confirmation email.
    confirmEmail(tokenHash: string): Promise<AuthSession>;
    refresh(refreshToken: string): Promise<AuthSession>;
    // Revokes the session at Supabase so its refresh token stops working (SEC-022).
    logout(session: { accessToken: string; refreshToken: string }): Promise<void>;
}

// The browser never talks to Supabase Auth: this service does, on its behalf. It uses the
// publishable key (the same key a browser app would use), never the service-role key.
export function createAuthService(config: { supabaseUrl: string; publishableKey: string }): AuthService {
    // A new client for every call: a client holds the signed-in user's session in memory, so a
    // shared one would mix up users who sign in at the same time.
    const newClient = () =>
        createClient(config.supabaseUrl, config.publishableKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });

    return {
        async register(email, password) {
            const { error } = await newClient().auth.signUp({ email, password });
            if (error) throw mapError(error);
        },

        async login(email, password) {
            const { data, error } = await newClient().auth.signInWithPassword({ email, password });
            if (error) {
                // Same answer for "no such account" and "wrong password" (SEC-024).
                if (error.code === "invalid_credentials") {
                    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
                }
                // Only reachable with the correct password, so it tells an attacker nothing.
                if (error.code === "email_not_confirmed") {
                    throw new AppError(403, "EMAIL_NOT_CONFIRMED", "Confirm your email address before signing in");
                }
                throw mapError(error);
            }
            return toAuthSession(data.session);
        },

        async confirmEmail(tokenHash) {
            const { data, error } = await newClient().auth.verifyOtp({ token_hash: tokenHash, type: "email" });
            if (error) {
                throw new AppError(400, "INVALID_LINK", "This confirmation link is invalid or has expired");
            }
            return toAuthSession(data.session);
        },

        async refresh(refreshToken) {
            const { data, error } = await newClient().auth.refreshSession({ refresh_token: refreshToken });
            if (error) throw new UnauthorizedError();
            return toAuthSession(data.session);
        },

        async logout({ accessToken, refreshToken }) {
            const client = newClient();
            const { error: sessionError } = await client.auth.setSession({
                access_token: accessToken,
                refresh_token: refreshToken,
            });
            if (sessionError) throw sessionError;
            // "local" ends this browser's session only, not the user's sessions on other devices.
            const { error } = await client.auth.signOut({ scope: "local" });
            if (error) throw error;
        },
    };
}

function toAuthSession(session: Session | null): AuthSession {
    if (!session) throw new UnauthorizedError();
    return {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresIn: session.expires_in,
    };
}

// Turns the Supabase errors a user can cause into safe, documented API errors.
// Anything else is returned as is and becomes the generic 500 (details logged, never sent).
function mapError(error: AuthError): Error {
    if (error.code === "weak_password") return new ValidationError("Password is too weak", "password");
    if (error.code === "email_address_invalid") return new ValidationError("Enter a valid email address", "email");
    if (error.status === 429 || error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit") {
        return new AppError(429, "RATE_LIMITED", "Too many attempts. Try again later");
    }
    return error;
}
