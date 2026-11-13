import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Starts a throwaway local PostgreSQL for the database tests (skipped if none is installed).
        globalSetup: ["tests/setup/localPostgres.ts"],
    },
});
