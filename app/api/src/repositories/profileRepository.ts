import type pg from "pg";
import { withUserContext } from "../db/pool.js";

const PROFILE_COLUMNS = `id, email, time_zone AS "timeZone", monthly_summary AS "monthlySummary", created_at AS "createdAt"`;
// The only profile settings a user can change, and the column each maps to: never the email or id.
const SETTING_COLUMNS = { timeZone: "time_zone", monthlySummary: "monthly_summary" } as const;
export type ProfileSettings = Partial<{ timeZone: string; monthlySummary: boolean }>;

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
                    `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = $1`,
                    [userId],
                );
                return rows[0] ?? null;
            });
        },

        // Changes the caller's settings (time zone, monthly summary). Column names come from the fixed
        // map above, values are parameters; the grant allows only these columns (and updated_at) and
        // the policy only the caller's own row. Returns the updated profile, or null if there is none.
        async update(userId: string, settings: ProfileSettings): Promise<Profile | null> {
            const entries = Object.entries(settings).filter(([, value]) => value !== undefined) as Array<[keyof typeof SETTING_COLUMNS, unknown]>;
            if (entries.length === 0) throw new Error("no settings to change");
            const sets = entries.map(([key], i) => `${SETTING_COLUMNS[key]} = $${i + 2}`).join(", ");
            return withUserContext(pool, userId, async (client) => {
                const { rows } = await client.query(
                    `UPDATE profiles SET ${sets}, updated_at = now() WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`,
                    [userId, ...entries.map(([, value]) => value)],
                );
                return rows[0] ?? null;
            });
        },
    };
}

export interface Profile {
    id: string;
    email: string;
    timeZone: string;
    monthlySummary: boolean;
    createdAt: Date;
}

export type ProfileRepository = ReturnType<typeof createProfileRepository>;

// Story 10: every user who wants the monthly summary, with their address and time zone.
// Cross-user, so it runs only on the job role's pool (job_runner), never as app_user.
export async function findMonthlySummaryRecipients(db: Pick<pg.Pool, "query">): Promise<Array<{ userId: string; email: string; timeZone: string }>> {
    const { rows } = await db.query(
        `SELECT id AS "userId", email, time_zone AS "timeZone" FROM profiles WHERE monthly_summary ORDER BY id`,
    );
    return rows;
}
