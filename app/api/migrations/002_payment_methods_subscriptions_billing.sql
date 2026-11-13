-- Story 2 (Add a Subscription): payment methods, subscriptions and the billing ledger.
-- Run once in the Supabase SQL editor, after 001. Never edit after running; later changes go in a new file.

CREATE TYPE payment_method_type    AS ENUM ('credit_card', 'debit_card', 'apple_pay');
CREATE TYPE billing_period_type    AS ENUM ('monthly', '6_months', 'annually');
CREATE TYPE subscription_type_enum AS ENUM ('recurring', 'one_time');
CREATE TYPE subscription_status    AS ENUM ('active', 'active-unknown', 'inactive');
CREATE TYPE billing_cycle_status   AS ENUM ('paid', 'due');
CREATE TYPE billing_creator        AS ENUM ('user', 'system');

-- A user's stored payment methods. Never deleted, only deactivated (BR-019): subscriptions and billing rows point at them.
CREATE TABLE payment_methods (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type       payment_method_type NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The target of the composite foreign keys below: lets the database itself refuse a row that points at another user's payment method (foreign key checks bypass row-level security).
  UNIQUE (id, user_id)
);
CREATE INDEX idx_payment_methods_user ON payment_methods(user_id, is_active);

CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  category          TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 50),
  price             NUMERIC(10,2) NOT NULL CHECK (price > 0),
  billing_period    billing_period_type,
  subscription_type subscription_type_enum NOT NULL,
  start_date        DATE NOT NULL,
  payment_method_id UUID NOT NULL,
  -- Backstop for the API's link rule (SEC-035): http(s) only, at most 2048 characters.
  renewal_link      TEXT CHECK (renewal_link IS NULL OR (char_length(renewal_link) <= 2048 AND renewal_link ~* '^https?://')),
  cancellation_link TEXT CHECK (cancellation_link IS NULL OR (char_length(cancellation_link) <= 2048 AND cancellation_link ~* '^https?://')),
  auto_renews       BOOLEAN NOT NULL DEFAULT false,
  status            subscription_status NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The payment method must belong to the same user as the subscription.
  FOREIGN KEY (payment_method_id, user_id) REFERENCES payment_methods (id, user_id),
  -- BR-017: a billing period is required for recurring and absent for one-time.
  CONSTRAINT billing_period_matches_type CHECK (
    (subscription_type = 'recurring' AND billing_period IS NOT NULL) OR
    (subscription_type = 'one_time'  AND billing_period IS NULL)
  )
);

CREATE INDEX idx_subscriptions_user_status   ON subscriptions(user_id, status);
CREATE INDEX idx_subscriptions_user_category ON subscriptions(user_id, category);

-- The billing ledger: one row per billing cycle, append-only (BR-021).
-- The three links are required while the account exists and become NULL only when the owner deletes the account (BR-036). The trigger below allows no other change.
CREATE TABLE billing (
  transaction_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  user_id           UUID REFERENCES profiles(id) ON DELETE SET NULL,
  amount            NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
  status            billing_cycle_status NOT NULL DEFAULT 'paid',
  due_date          DATE NOT NULL,
  created_by        billing_creator NOT NULL,   -- SEC-043: a user request or a system job
  request_id        TEXT,                       -- SEC-043: correlation id of the creating request or job run
  idempotency_key   TEXT,                       -- SEC-041: used by POST /renew
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- These are plain single-column keys on purpose: ON DELETE SET NULL then clears each link independently, which is how account deletion de-identifies a row (BR-036). A composite key on (subscription_id, user_id) does not work here, because user_id is cleared first and the other links would then be left pointing at rows that no longer exist. That the referenced rows belong to the same user is enforced by the insert policy below instead. SEC-041: one cycle per subscription per due date. NULLs are distinct, so de-identified rows never collide.
  UNIQUE (subscription_id, due_date),
  UNIQUE (subscription_id, idempotency_key)
);
CREATE INDEX idx_billing_subscription_due ON billing(subscription_id, due_date DESC);
CREATE INDEX idx_billing_user_due ON billing(user_id, due_date);
-- Speeds up the daily overdue sweep. De-identified rows (subscription_id IS NULL) are never swept.
CREATE INDEX idx_billing_overdue_candidates ON billing(due_date)
  WHERE status = 'paid' AND subscription_id IS NOT NULL;

-- Immutability (BR-021, SEC-042): a database backstop, so a bug in the API cannot rewrite history.
-- Allowed: the single paid -> due lapse, and clearing a link to NULL once the row it pointed to is gone.
-- search_path is empty (as in 001), so every name is schema-qualified.
CREATE FUNCTION public.enforce_billing_immutability() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing records cannot be deleted';
  END IF;

  IF NEW.transaction_id <> OLD.transaction_id OR
     NEW.amount         <> OLD.amount         OR
     NEW.due_date       <> OLD.due_date       OR
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

CREATE TRIGGER billing_immutability
  BEFORE UPDATE OR DELETE ON billing
  FOR EACH ROW EXECUTE FUNCTION public.enforce_billing_immutability();

-- Story 2 only creates and reads. No UPDATE or DELETE for the API role on any of these tables;
-- later stories grant exactly what they need.
GRANT SELECT, INSERT ON public.payment_methods, public.subscriptions, public.billing TO app_user;

-- Row-level security, as for profiles: a user sees and creates only their own rows. With no user
-- context the setting is empty, the comparison is NULL, and nothing matches (fails closed).
-- A de-identified billing row has user_id NULL, so no user ever matches it either.
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing         ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_methods_select_own ON public.payment_methods FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY payment_methods_insert_own ON public.payment_methods FOR INSERT TO app_user
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY subscriptions_select_own ON public.subscriptions FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY subscriptions_insert_own ON public.subscriptions FOR INSERT TO app_user
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY billing_select_own ON public.billing FOR SELECT TO app_user
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
-- The subqueries are themselves filtered by row-level security, so a subscription or payment
-- method that belongs to someone else is invisible here and the insert is refused.
CREATE POLICY billing_insert_own ON public.billing FOR INSERT TO app_user
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM public.subscriptions s
                WHERE s.id = subscription_id AND s.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
    AND EXISTS (SELECT 1 FROM public.payment_methods p
                WHERE p.id = payment_method_id AND p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  );

-- Defence in depth: the Data API roles get nothing, even if it is re-enabled later.
REVOKE ALL ON public.payment_methods, public.subscriptions, public.billing FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_billing_immutability() FROM PUBLIC, anon, authenticated;
