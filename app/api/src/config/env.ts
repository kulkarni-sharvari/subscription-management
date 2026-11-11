// Single place that reads and validates the environment (src/config/env.ts).
// Everything else imports the typed result of loadEnv(), never process.env directly.
import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  //  the API uses 4000. coerce: env values arrive as strings.
  PORT: z.coerce.number().int().positive().default(4000),
  // Must be the app_user (least-privilege) connection string, not the admin one.
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.url(),
  // Exact origin of the React app, used for CORS.
  CORS_ORIGIN: z.string().min(1),
});

export type Env = z.infer<typeof configSchema>;

// Fails fast: a missing or malformed setting stops the server at startup instead of
// surfacing as an unclear error on a later request. `source` lets tests pass a fake environment.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    // Names only: values such as DATABASE_URL contain secrets and must never reach logs (SEC-019).
    const names = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${names}`);
  }
  return parsed.data;
}
