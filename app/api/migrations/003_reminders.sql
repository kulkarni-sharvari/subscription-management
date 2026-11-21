-- Story 4 (Get Reminded Before Renewal): each user's time zone, the notification log, the per-user
-- daily email counter, and the role the scheduled jobs connect as.

-- The user's IANA time zone (for example America/New_York). It decides which calendar day it is
-- for that user, so "renews in 3 days" and "send at 09:00" mean their days and their morning.
-- The API checks the name is a real zone; the database only bounds its length.
ALTER TABLE public.profiles ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (char_length(time_zone) BETWEEN 1 AND 64);

-- The API may change exactly these two columns of the caller's own profile, nothing else (not the email).
GRANT UPDATE (time_zone, updated_at) ON public.profiles TO app_user;
CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO app_user
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- A record of notifications already sent, so a job that runs twice cannot send twice (FR-051,
-- NFR-041). The unique key is the guard: INSERT ... ON CONFLICT DO NOTHING returns no row when the
-- notification was already recorded. A reminder digest is recorded once per user per local day.
CREATE TABLE public.notification_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE, -- null for per-user notifications (digests, summaries)
  notification_type TEXT NOT NULL CHECK (notification_type IN
                      ('reminder_digest', 'escalation', 'status_changed', 'monthly_summary', 'import_summary')),
  dedup_key         TEXT NOT NULL CHECK (char_length(dedup_key) BETWEEN 1 AND 200), -- e.g. 'reminder-digest:2026-11-20'
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, notification_type, dedup_key)
);

-- Emails sent to each user per UTC day, for the daily cap (SEC-048). Every email reserves a slot
-- here first; when the cap is reached, the reservation returns nothing and the email is not sent.
CREATE TABLE public.email_daily_count (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  PRIMARY KEY (user_id, day)
);

-- The API (as the user) reserves slots for the emails a user's own actions send, such as "subscription added".
GRANT SELECT, INSERT, UPDATE (sent) ON public.email_daily_count TO app_user;
ALTER TABLE public.notification_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_daily_count ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_daily_count_select_own ON public.email_daily_count FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY email_daily_count_insert_own ON public.email_daily_count FOR INSERT TO app_user
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY email_daily_count_update_own ON public.email_daily_count FOR UPDATE TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- The role the scheduled jobs connect as. Jobs work across all users, which app_user is built to
-- prevent, so they get their own role instead of the admin one: it reads only the columns the
-- reminder job needs, writes only the two notification tables, and changes no subscription,
-- billing or profile data. Later jobs add exactly the grants they need.
CREATE ROLE job_runner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO job_runner;
GRANT SELECT (id, email, time_zone) ON public.profiles TO job_runner;
GRANT SELECT (id, user_id, name, price, billing_period, subscription_type, status, renewal_link, payment_method_id)
  ON public.subscriptions TO job_runner;
GRANT SELECT (id, user_id, type) ON public.payment_methods TO job_runner;
GRANT SELECT (subscription_id, user_id, due_date, status) ON public.billing TO job_runner;
GRANT SELECT, INSERT ON public.notification_log TO job_runner;
GRANT SELECT, INSERT, UPDATE (sent) ON public.email_daily_count TO job_runner;

-- Row-level security is on for all of these tables, so the job role needs policies too. They are
-- deliberately cross-user (USING true): the column grants above, not the rows, are its limit.
CREATE POLICY profiles_select_jobs          ON public.profiles          FOR SELECT TO job_runner USING (true);
CREATE POLICY subscriptions_select_jobs     ON public.subscriptions     FOR SELECT TO job_runner USING (true);
CREATE POLICY payment_methods_select_jobs   ON public.payment_methods   FOR SELECT TO job_runner USING (true);
CREATE POLICY billing_select_jobs           ON public.billing           FOR SELECT TO job_runner USING (true);
CREATE POLICY notification_log_select_jobs  ON public.notification_log  FOR SELECT TO job_runner USING (true);
CREATE POLICY notification_log_insert_jobs  ON public.notification_log  FOR INSERT TO job_runner WITH CHECK (true);
CREATE POLICY email_daily_count_select_jobs ON public.email_daily_count FOR SELECT TO job_runner USING (true);
CREATE POLICY email_daily_count_insert_jobs ON public.email_daily_count FOR INSERT TO job_runner WITH CHECK (true);
CREATE POLICY email_daily_count_update_jobs ON public.email_daily_count FOR UPDATE TO job_runner USING (true) WITH CHECK (true);

-- Defence in depth: the Data API roles get nothing, even if it is re-enabled later.
REVOKE ALL ON public.notification_log, public.email_daily_count FROM anon, authenticated;

-- After running this file, set the password outside it so it is never committed:
--   ALTER ROLE job_runner PASSWORD '<a long random password>';
-- and put the job_runner connection string (session pooler, user job_runner.<project-ref>) in
-- JOB_DATABASE_URL.
