-- Story 7 (Reconcile an Active-Unknown Subscription: Cancelled): the day the user recorded the
-- cancellation, in their own calendar. Set only by the API, never sent by the browser; a later
-- reactivation clears it. It may exist only on an inactive subscription.
ALTER TABLE public.subscriptions ADD COLUMN cancelled_on DATE
  CHECK (cancelled_on IS NULL OR status = 'inactive');

-- The API may set it on the caller's own subscriptions (the update policy from migration 005 applies).
GRANT UPDATE (cancelled_on) ON public.subscriptions TO app_user;
