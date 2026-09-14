# Database Design

## Subscription Manager — PostgreSQL Schema (Supabase)

Translates `docs/architecture/data-model.md` into concrete DDL. Builds on `docs/product/prd.md` (v1.1) and `docs/architecture/decisions.md`.

**Status:** Schema is ready except one open decision — see [Authorization Enforcement Strategy](#authorization-enforcement-strategy) below, which needs to be settled before the API layer is designed, since it determines how the Node API connects to Postgres.

---

## Enum Types

```sql
CREATE TYPE payment_method_type AS ENUM ('credit_card', 'debit_card', 'apple_pay');
CREATE TYPE billing_period_type AS ENUM ('monthly', '6_months', 'annually');
CREATE TYPE subscription_type_enum AS ENUM ('recurring', 'one_time');
CREATE TYPE subscription_status AS ENUM ('active', 'active-unknown', 'inactive');
CREATE TYPE billing_cycle_status AS ENUM ('paid', 'due');
```

---

## `profiles`

One row per Supabase Auth user (`auth.users`), created automatically — never by the app directly (FR-001).

```sql
CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create a profile whenever Supabase Auth creates a user.
CREATE FUNCTION handle_new_user() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Keep the denormalized email copy in sync if it changes via Supabase Auth.
CREATE FUNCTION sync_user_email() RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles SET email = NEW.email, updated_at = now() WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_email_updated
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION sync_user_email();
```

---

## `payment_methods`

```sql
CREATE TABLE payment_methods (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type       payment_method_type NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_methods_user ON payment_methods(user_id, is_active);
```

No delete — `deactivatePaymentMethod` is `UPDATE ... SET is_active = false` (BR-019). Referenced by `subscriptions.payment_method_id` and `billing.payment_method_id`, so it's never removable without breaking those FKs — soft-delete is required, not just a style choice.

---

## `subscriptions`

```sql
CREATE TABLE subscriptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL,
  price              NUMERIC(10,2) NOT NULL CHECK (price > 0),
  billing_period     billing_period_type,
  subscription_type  subscription_type_enum NOT NULL,
  start_date         DATE NOT NULL,
  payment_method_id  UUID NOT NULL REFERENCES payment_methods(id),
  renewal_link       TEXT,
  cancellation_link  TEXT,
  auto_renews        BOOLEAN NOT NULL DEFAULT false,
  status             subscription_status NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- BR-017: billing_period required for recurring, absent for one_time.
  CONSTRAINT billing_period_matches_type CHECK (
    (subscription_type = 'recurring' AND billing_period IS NOT NULL) OR
    (subscription_type = 'one_time'  AND billing_period IS NULL)
  )
);

CREATE INDEX idx_subscriptions_user_status ON subscriptions(user_id, status);
CREATE INDEX idx_subscriptions_user_category ON subscriptions(user_id, category);
```

No delete — matches BR-009 (`inactive` is the only removal path).

---

## `billing`

Full historical ledger — one row per billing cycle (BR-021). Append-only.

```sql
CREATE TABLE billing (
  transaction_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id    UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount             NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_method_id  UUID NOT NULL REFERENCES payment_methods(id),
  status             billing_cycle_status NOT NULL DEFAULT 'paid',
  due_date           DATE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_subscription_due ON billing(subscription_id, due_date DESC);
CREATE INDEX idx_billing_user_due ON billing(user_id, due_date);

-- Speeds up the daily overdue sweep: "find every paid row whose due date has passed."
CREATE INDEX idx_billing_overdue_candidates ON billing(due_date) WHERE status = 'paid';
```

**"Current cycle" for a subscription** = the `billing` row with the latest `due_date` for that `subscription_id` (`ORDER BY due_date DESC LIMIT 1`). No separate `is_current` flag — the table is small per subscription and this query is cheap; add one later only if it becomes a measured bottleneck (per the "don't add complexity without a real requirement" principle).

**Enforcing immutability at the DB level (BR-021):** rather than relying only on the Node API to never issue a disallowed write, a trigger rejects anything except the one permitted `paid → due` transition and blocks all deletes outright:

```sql
CREATE FUNCTION enforce_billing_immutability() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing records cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'paid' OR NEW.status <> 'due' THEN
      RAISE EXCEPTION 'billing records only support a paid -> due transition';
    END IF;
    -- Only status/updated_at may change; every other column must be identical.
    IF NEW.transaction_id  <> OLD.transaction_id  OR
       NEW.subscription_id <> OLD.subscription_id OR
       NEW.user_id         <> OLD.user_id         OR
       NEW.amount          <> OLD.amount          OR
       NEW.payment_method_id <> OLD.payment_method_id OR
       NEW.due_date        <> OLD.due_date         OR
       NEW.created_at      <> OLD.created_at THEN
      RAISE EXCEPTION 'only status and updated_at may change on a billing record';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_immutability
  BEFORE UPDATE OR DELETE ON billing
  FOR EACH ROW EXECUTE FUNCTION enforce_billing_immutability();
```

This is the DB-level backstop for BR-021 — a bug in the Node API can't silently rewrite billing history even if it tries.

---

## `notification_log`

A minimal dedup ledger, not a domain entity — `decisions.md` already decided against a rich `Notification` entity, but FR-051/NFR-041 still need *some* record of "was this specific email already sent," or a job that runs twice on the same day would double-send. This table exists purely to make sends idempotent, nothing more.

```sql
CREATE TABLE notification_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES subscriptions(id) ON DELETE CASCADE, -- null for account-level notifications (monthly summary)
  notification_type TEXT NOT NULL, -- 'created' | 'reminder' | 'escalation' | 'status_changed' | 'monthly_summary'
  dedup_key         TEXT NOT NULL, -- the specific instance being guarded against duplicates, e.g. 'reminder:5:2026-09-20', 'monthly:2026-09'
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, notification_type, dedup_key)
);
```

Usage: before sending, `INSERT ... ON CONFLICT (user_id, notification_type, dedup_key) DO NOTHING RETURNING id` — if no row comes back, it was already sent, skip. If a row comes back, send and it's now recorded. No separate "check then send" race condition, since the uniqueness check and the record happen in one statement.

---

## Authorization Enforcement Strategy

**Decided: enforced repository layer, no RLS.** See `docs/architecture/decisions.md` ("Authorization Enforcement Strategy") for the full pros/cons this was weighed against (plain application-code checks, and RLS-based defense-in-depth).

RLS was considered and deliberately not used: this project's frontend never talks to Postgres directly (no PostgREST from the client) — a separate Node.js API is the sole enforcement point (FR-005, BR-001/002) — and at this project's single-developer, personal-app scale, RLS's benefit (catching a mistake nobody else would review) is outweighed by its cost (Supabase pooler/session-state quirks, needing a second privileged path for system-triggered work like the overdue sweep anyway, and duplicating the ownership rule in two places).

**The pattern:** the Node API connects to Postgres with a single privileged connection pool (the Supabase service-role key, or an equivalent direct Postgres role) — but route/service code never touches that pool directly. Every table is only reachable through a per-entity repository module, and every exported function on it takes `userId` as a required argument that's always applied as a `WHERE`/`AND` filter internally. There's no lower-level "raw query" escape hatch available outside the repository modules, so a missing ownership check can't compile/ship rather than relying on someone remembering to add it inline in a route handler.

```text
routes/subscriptions.ts        -- no DB client import allowed here
  -> services/subscriptions.ts -- business logic (state transitions, billing writes)
    -> repositories/subscriptions.ts -- ONLY place the `subscriptions`/`billing` tables are queried
         getByStatus(userId, status)       -- always: WHERE user_id = $1 AND status = $2
         getById(userId, subscriptionId)   -- always: WHERE id = $1 AND user_id = $2
         create(userId, data)
         update(userId, subscriptionId, data)
```

System-triggered work (the Supabase-Cron overdue sweep, which touches *all* users' rows) calls repository functions marked explicitly as cross-user (e.g., `getAllDueForTransition()`, with no `userId` parameter at all), kept in a clearly separate section of the repository so it's obvious at a glance which functions are user-scoped and which are intentionally not.

This is a code-organization/code-review discipline, not a database-enforced guarantee — the tradeoff made consciously in exchange for avoiding RLS's operational cost at this project's scale.
