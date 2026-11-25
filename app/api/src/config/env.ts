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
  // Supabase "publishable" (anon) key. Safe to ship in a browser app; never the service-role key.
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  // Exact origin of the React app, used for CORS.
  CORS_ORIGIN: z.string().min(1),
  // Resend (transactional email). EMAIL_FROM must be on a domain verified in Resend, or
  // "Subscription Manager <onboarding@resend.dev>" while testing.
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  // How many reverse proxies sit in front of the API (0 = none, as in development). Rate limits
  // are counted per client address, which is only correct if the API knows how many hops to skip.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Connection string of the job_runner role (migrations/003_reminders.sql), used only by the
  // scheduled jobs. Not app_user and not the admin role.
  JOB_DATABASE_URL: z.string().min(1),
  // Shared secret Supabase Cron sends in X-Internal-Job-Secret (SEC-016): at least 32 random bytes,
  // which is 43 characters in base64url.
  INTERNAL_JOB_SECRET: z.string().min(43),
  // Signs the unsubscribe link in the monthly summary email (Story 10). At least 32 random bytes
  // (43 characters in base64url), and different from INTERNAL_JOB_SECRET.
  EMAIL_LINK_SECRET: z.string().min(43),
}).refine((env) => env.EMAIL_LINK_SECRET !== env.INTERNAL_JOB_SECRET, { path: ["EMAIL_LINK_SECRET"] });

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
