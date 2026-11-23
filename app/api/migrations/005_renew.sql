-- Story 6 (Reconcile an Active-Unknown Subscription: Renewed): the API may now change these
-- columns of the caller's own subscriptions, and nothing else. The billing ledger stays
-- insert-only for the API: a renewal adds rows, it never edits one (BR-021).
--   status            -> active again
--   price, payment_method_id -> "cost or payment method changed" (they apply going forward)
--   billing_period    -> a different plan from now on (BR-017's check still requires one for recurring)
--   start_date        -> the new streak's start when the user restarted after a gap (BR-013)
GRANT UPDATE (status, price, payment_method_id, billing_period, start_date, updated_at) ON public.subscriptions TO app_user;

CREATE POLICY subscriptions_update_own ON public.subscriptions FOR UPDATE TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
-- The payment method stays the user's own: the composite foreign key (payment_method_id, user_id)
-- from migration 002 refuses anyone else's, whatever the API sends.
