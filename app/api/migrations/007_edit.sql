-- Story 8 (Edit Subscription Details): the API may also change these plain details of the
-- caller's own subscriptions (price, payment_method_id and billing_period were granted in 005).
-- Never start_date by editing, never the subscription type, and still nothing in the billing
-- ledger: an edit applies from the next renewal (FR-030).
GRANT UPDATE (name, category, renewal_link, cancellation_link, auto_renews) ON public.subscriptions TO app_user;
