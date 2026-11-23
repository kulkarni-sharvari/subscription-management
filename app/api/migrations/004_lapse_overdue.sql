-- Story 5 (Subscription Goes Unreconciled at Renewal): the overdue job may move a subscription
-- from active to active-unknown and its current billing cycle from paid to due, and nothing else.

-- Columns: only the two status columns and their timestamps. transaction_id is readable so the
-- job can name the exact cycle it lapses.
GRANT SELECT (transaction_id) ON public.billing TO job_runner;
GRANT UPDATE (status, updated_at) ON public.subscriptions TO job_runner;
GRANT UPDATE (status, updated_at) ON public.billing TO job_runner;

-- The policies allow exactly one transition each, so even a bug in the job (or a leaked job_runner password) cannot cancel, reactivate or "un-lapse" anything. -- USING picks the rows it may touch & WITH CHECK is what the row must look like afterwards.
CREATE POLICY subscriptions_lapse_jobs ON public.subscriptions FOR UPDATE TO job_runner
  USING (status = 'active') WITH CHECK (status = 'active-unknown');
CREATE POLICY billing_lapse_jobs ON public.billing FOR UPDATE TO job_runner
  USING (status = 'paid') WITH CHECK (status = 'due');
