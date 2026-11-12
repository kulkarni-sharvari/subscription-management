// Story 1 security tests that read the project itself: configuration and the SPA source.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const webSrc = join(repoRoot, "app", "web", "src");
const apiSrc = join(repoRoot, "app", "api", "src");

const validEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://app_user.ref:very-secret-pw@host:5432/postgres",
    SUPABASE_URL: "https://testref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    CORS_ORIGIN: "http://localhost:3000",
};

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
}
const read = (path: string) => readFileSync(path, "utf8");
// Code only: comments are allowed to say "never use the service-role key".
const readCode = (path: string) =>
    read(path)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

describe("SEC-019: configuration fails closed and never prints values", () => {
    it("accepts a complete configuration", () => {
        expect(loadEnv(validEnv).PORT).toBe(4000);
    });

    it.each(["DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "CORS_ORIGIN"])(
        "refuses to start without %s, and the error names the setting only",
        (name) => {
            const env: Record<string, string | undefined> = { ...validEnv, [name]: undefined };
            expect(() => loadEnv(env)).toThrow(`Invalid configuration: ${name}`);
        },
    );

    it("does not put secret values in the error message", () => {
        const env = { ...validEnv, SUPABASE_URL: "not-a-url", DATABASE_URL: "postgresql://u:very-secret-pw@h/db" };
        try {
            loadEnv(env);
            expect.unreachable();
        } catch (err) {
            expect(String(err)).not.toContain("very-secret-pw");
            expect(String(err)).not.toContain("not-a-url");
        }
    });
});

describe("SEC-017: no secret keys in the SPA or the repository", () => {
    it("neither source tree mentions the service-role key", () => {
        for (const file of [...sourceFiles(webSrc), ...sourceFiles(apiSrc)]) {
            expect(readCode(file), relative(repoRoot, file)).not.toMatch(/service[_-]?role/i);
        }
    });

    it("the SPA has no VITE_ configuration variables at all (nothing to leak into the bundle)", () => {
        for (const file of sourceFiles(webSrc)) {
            expect(read(file), relative(repoRoot, file)).not.toMatch(/import\.meta\.env\.VITE_/);
        }
    });

    it("no .env file with real values is tracked by git (only .env.example)", () => {
        const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n");
        const envFiles = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example"));
        expect(envFiles).toEqual([]);
    });
});

describe("T-02a / SEC-036: the SPA never holds tokens and never renders raw HTML", () => {
    const files = sourceFiles(webSrc);

    it("has source files to scan", () => {
        expect(files.length).toBeGreaterThan(5);
    });

    it("uses no browser storage and never reads cookies (tokens are httpOnly, so there is nothing to store)", () => {
        for (const file of files) {
            expect(read(file), relative(repoRoot, file)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
        }
    });

    it("never injects raw HTML or evaluates strings", () => {
        for (const file of files) {
            expect(read(file), relative(repoRoot, file)).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\beval\(|new Function\(/);
        }
    });

    it("has no Supabase client in the browser (the API owns the session)", () => {
        const webPackage = JSON.parse(read(join(repoRoot, "app", "web", "package.json")));
        const deps = { ...webPackage.dependencies, ...webPackage.devDependencies };
        expect(Object.keys(deps).filter((name) => name.includes("supabase"))).toEqual([]);
    });

    it("sends credentials only to our own origin and sends nothing to the URL bar", () => {
        const client = read(join(webSrc, "api", "client.ts"));
        expect(client).toContain("credentials: 'same-origin'");
        expect(client).not.toMatch(/credentials:\s*'include'/);
        expect(client).not.toMatch(/https?:\/\//);
    });
});
