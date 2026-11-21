// Starts a throwaway PostgreSQL for the tests, applies every file in migrations/ to it, and hands
// the tests two connection strings. Nothing outside a temporary folder is touched, and the server
// is stopped and deleted afterwards. If PostgreSQL is not installed, the database tests skip.
//
// Look for the binaries in: PG_BIN_DIR, the PATH, Homebrew, and the Debian/Ubuntu location.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";

export interface LocalPg {
    // Superuser: used to create users and to try what the application role must not be able to do.
    adminUrl: string;
    // The least-privilege role the API connects as.
    appUrl: string;
    // The role the scheduled jobs connect as.
    jobUrl: string;
}

declare module "vitest" {
    export interface ProvidedContext {
        localPg: LocalPg | null;
    }
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

// Stand-in for the parts of Supabase the migrations rely on.
const SUPABASE_STUB = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
`;

function findBinDir(): string | null {
    const candidates: string[] = [];
    if (process.env.PG_BIN_DIR) candidates.push(process.env.PG_BIN_DIR);
    try {
        candidates.push(dirname(execFileSync("which", ["initdb"], { encoding: "utf8" }).trim()));
    } catch {
        /* not on the PATH */
    }
    for (const root of ["/opt/homebrew/opt", "/usr/local/opt", "/usr/lib/postgresql"]) {
        if (!existsSync(root)) continue;
        for (const name of readdirSync(root).filter((n) => n.startsWith("postgresql") || /^\d+$/.test(n))) {
            candidates.push(join(root, name, "bin"));
        }
    }
    return candidates.find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl"))) ?? null;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

export default async function setup(project: TestProject) {
    const bin = findBinDir();
    if (!bin) {
        console.warn("PostgreSQL not found: the local database tests will be skipped (set PG_BIN_DIR to enable them)");
        project.provide("localPg", null);
        return;
    }

    const dir = mkdtempSync(join(tmpdir(), "subman-pg-"));
    const port = await freePort();
    const data = join(dir, "data");
    const run = (name: string, args: string[]) => execFileSync(join(bin, name), args, { stdio: "pipe" });

    run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync"]);
    // TCP only (a Unix socket path can be too long); safe-to-lose settings that make it faster.
    run("pg_ctl", [
        "-D", data, "-w", "-l", join(dir, "log"),
        "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
        "start",
    ]);

    try {
        const base = `postgresql://postgres@127.0.0.1:${port}`;
        const boot = new pg.Client({ connectionString: `${base}/postgres` });
        await boot.connect();
        await boot.query("CREATE DATABASE app_test");
        await boot.end();

        const admin = new pg.Client({ connectionString: `${base}/app_test` });
        await admin.connect();
        await admin.query(SUPABASE_STUB);
        for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
            await admin.query(readFileSync(join(migrationsDir, file), "utf8"));
        }
        // Production sets this with \password; here any value will do, over loopback only.
        await admin.query("ALTER ROLE app_user PASSWORD 'local-test-only'");
        await admin.query("ALTER ROLE job_runner PASSWORD 'local-test-only'");
        await admin.end();

        project.provide("localPg", {
            adminUrl: `${base}/app_test`,
            appUrl: `postgresql://app_user:local-test-only@127.0.0.1:${port}/app_test`,
            jobUrl: `postgresql://job_runner:local-test-only@127.0.0.1:${port}/app_test`,
        });
    } catch (err) {
        run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
        rmSync(dir, { recursive: true, force: true });
        throw err;
    }

    return () => {
        run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
        rmSync(dir, { recursive: true, force: true });
    };
}
