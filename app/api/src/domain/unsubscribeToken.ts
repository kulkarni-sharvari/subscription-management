import { createHmac, timingSafeEqual } from "node:crypto";

// Story 10: the one-click unsubscribe link in the monthly summary (RFC 8058). The link must work
// without signing in, so it carries the user id and an HMAC-SHA256 signature of it, made with a
// server secret (EMAIL_LINK_SECRET). Without the secret no one can make a valid link for another
// user. The purpose and a version are signed too, so this signature can never be reused for any
// other action, and changing the secret or the version invalidates every old link.
// It has no expiry on purpose: mail providers expect an unsubscribe link to keep working, and the
// only thing it can do is turn the monthly email off, which the user can undo in the app.
const PURPOSE = "monthly-summary-unsubscribe:v1:";

export function unsubscribeToken(secret: string, userId: string): string {
    return createHmac("sha256", secret).update(PURPOSE + userId).digest("base64url");
}

// Compared in constant time, after checking the length, so the check leaks nothing.
export function isValidUnsubscribeToken(secret: string, userId: string, token: string): boolean {
    const expected = Buffer.from(unsubscribeToken(secret, userId));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}
