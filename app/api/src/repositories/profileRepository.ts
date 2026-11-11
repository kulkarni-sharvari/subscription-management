import type pg from "pg";
import { withUserContext } from "../db/pool.js";

// Repositories are the only place queries live. Every user-scoped query runs inside
// withUserContext so the RLS policy sees the user (db/pool.ts, migrations/001_profiles_and_roles.sql).
export function createProfileRepository(pool: pg.Pool) {
    return {
        // Does a profiles row exist for this user id? A deleted account has none (SEC-068).
        // The policy only lets a user see their own row, which is exactly the row asked about,
        // so the RLS filter never hides the answer: no row means no profile.
        async exists(userId: string): Promise<boolean> {
            return withUserContext(pool, userId, async (client) => {
                const { rowCount } = await client.query("SELECT 1 FROM profiles WHERE id = $1", [userId]);
                return rowCount === 1;
            });
        },

        // The caller's own profile, or null if there is none. Only the columns the API returns.
        async findById(userId: string): Promise<Profile | null> {
            return withUserContext(pool, userId, async (client) => {
                const { rows } = await client.query(
                    `SELECT id, email, created_at AS "createdAt" FROM profiles WHERE id = $1`,
                    [userId],
                );
                return rows[0] ?? null;
            });
        },
    };
}

export interface Profile {
    id: string;
    email: string;
    createdAt: Date;
}

export type ProfileRepository = ReturnType<typeof createProfileRepository>;
