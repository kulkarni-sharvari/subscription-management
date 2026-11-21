import { NotFoundError } from "../errors.js";
import type { ProfileRepository } from "../repositories/profileRepository.js";

// Routes call services, never repositories (LLD import boundaries).
export function createProfileService(profiles: Pick<ProfileRepository, "findById" | "setTimeZone">) {
    return {
        async getProfile(userId: string) {
            const profile = await profiles.findById(userId);
            // The auth middleware already confirmed the profile exists, so this only happens if
            // the account is deleted between that check and this query.
            if (!profile) throw new NotFoundError();
            return profile;
        },

        // The zone name is validated by the route before it gets here.
        async setTimeZone(userId: string, timeZone: string) {
            const profile = await profiles.setTimeZone(userId, timeZone);
            if (!profile) throw new NotFoundError();
            return profile;
        },
    };
}

export type ProfileService = ReturnType<typeof createProfileService>;
