import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Starts a throwaway local PostgreSQL for the database tests (skipped if none is installed).
        globalSetup: ["tests/setup/localPostgres.ts"],
        // The test files share one database, and the scheduled jobs work across all users: run
        // the files one after another so one file's job run cannot email or lapse another file's
        // users mid-test.
        fileParallelism: false,
    },
});
