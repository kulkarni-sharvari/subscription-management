-- Story 10 (Monthly Analytics Email): the user's choice to get the monthly summary, and what the job role needs to read to compute it.

-- On by default (FR-052). Turned off from the app's settings or the email's unsubscribe link.
ALTER TABLE public.profiles ADD COLUMN monthly_summary BOOLEAN NOT NULL DEFAULT true;

-- The API (as the user) may change this one more column of the caller's own row. The existing
-- profiles_update_own policy already limits it to that row. The unsubscribe link also writes as
-- the user it names, after its signature is checked, so it needs no other role.
GRANT UPDATE (monthly_summary) ON public.profiles TO app_user;

-- The monthly job (job_runner) reads the same figures as the Spending page, for every opted-in
-- user. It still writes nothing outside the two notification tables.
GRANT SELECT (monthly_summary) ON public.profiles TO job_runner;
GRANT SELECT (category) ON public.subscriptions TO job_runner;
GRANT SELECT (amount, paid_on) ON public.billing TO job_runner;
