-- Story 9 (View Spending Analytics): the day each payment was made. A billing row's due_date is the END of the period it paid for
-- spend in a date range needs the day the money was paid.
-- After a restart (Story 6) that day cannot be derived from the other rows, so it is stored.

ALTER TABLE public.billing ADD COLUMN paid_on DATE;

-- Existing rows: one period before the due date (the subscription's current period: an approximation where the period was changed later)
-- a one-time purchase is paid on its due date
-- a de-identified row (no subscription left) gets its due date. The trigger below does not yet know this column, so these updates pass it.
UPDATE public.billing b
   SET paid_on = CASE
         WHEN s.subscription_type = 'one_time' THEN b.due_date
         ELSE (b.due_date - CASE s.billing_period
                              WHEN 'monthly'  THEN interval '1 month'
                              WHEN '6_months' THEN interval '6 months'
                              ELSE                 interval '1 year'
                            END)::date
       END
  FROM public.subscriptions s
 WHERE s.id = b.subscription_id;
UPDATE public.billing SET paid_on = due_date WHERE paid_on IS NULL;

ALTER TABLE public.billing ALTER COLUMN paid_on SET NOT NULL;
ALTER TABLE public.billing ADD CONSTRAINT billing_paid_before_due CHECK (paid_on <= due_date);
-- Spend in a date range reads by user and payment day.
CREATE INDEX idx_billing_user_paid_on ON public.billing (user_id, paid_on);

-- The ledger's immutability backstop (migration 002) now also protects paid_on. Same function,
-- one more column in the "never changes" list.
CREATE OR REPLACE FUNCTION public.enforce_billing_immutability() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing records cannot be deleted';
  END IF;

  IF NEW.transaction_id <> OLD.transaction_id OR
     NEW.amount         <> OLD.amount         OR
     NEW.due_date       <> OLD.due_date       OR
     NEW.paid_on        <> OLD.paid_on        OR
     NEW.created_at     <> OLD.created_at     OR
     NEW.created_by     <> OLD.created_by     OR
     NEW.request_id      IS DISTINCT FROM OLD.request_id OR
     NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'billing records are immutable';
  END IF;

  IF NEW.status <> OLD.status AND NOT (OLD.status = 'paid' AND NEW.status = 'due') THEN
    RAISE EXCEPTION 'billing records only support a paid -> due transition';
  END IF;

  -- A link may only be cleared, never set or re-pointed, and only once its target no longer exists.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND
     (NEW.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.profiles WHERE id = OLD.user_id)) THEN
    RAISE EXCEPTION 'billing user_id can only be cleared when the profile no longer exists';
  END IF;
  IF NEW.subscription_id IS DISTINCT FROM OLD.subscription_id AND
     (NEW.subscription_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.subscriptions WHERE id = OLD.subscription_id)) THEN
    RAISE EXCEPTION 'billing subscription_id can only be cleared when the subscription no longer exists';
  END IF;
  IF NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id AND
     (NEW.payment_method_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.payment_methods WHERE id = OLD.payment_method_id)) THEN
    RAISE EXCEPTION 'billing payment_method_id can only be cleared when the payment method no longer exists';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.enforce_billing_immutability() FROM PUBLIC, anon, authenticated;
