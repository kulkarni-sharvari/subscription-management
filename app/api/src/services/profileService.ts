import { NotFoundError } from "../errors.js";
import type { ProfileRepository, ProfileSettings } from "../repositories/profileRepository.js";

// Routes call services, never repositories (LLD import boundaries).
export function createProfileService(profiles: Pick<ProfileRepository, "findById" | "update">) {
    return {
        async getProfile(userId: string) {
            const profile = await profiles.findById(userId);
            // The auth middleware already confirmed the profile exists, so this only happens if
            // the account is deleted between that check and this query.
            if (!profile) throw new NotFoundError();
            return profile;
        },

        // The values are validated by the route before they get here.
        async update(userId: string, settings: ProfileSettings) {
            const profile = await profiles.update(userId, settings);
            if (!profile) throw new NotFoundError();
            return profile;
        },
    };
}

export type ProfileService = ReturnType<typeof createProfileService>;
