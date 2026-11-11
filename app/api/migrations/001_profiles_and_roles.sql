-- Story 1 (Register / Log In)

-- One row per auth.users row. Rows are created by the trigger below, never by the app (FR-001).
-- ON DELETE CASCADE: deleting the auth user deletes the profile, which is how account deletion starts (Story 18). No name column: no requirement uses it yet.
CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger functions that write to profiles.
-- SECURITY DEFINER: runs with the privileges of the function's owner (postgres), because the
--   Supabase Auth service that fires the trigger cannot write to public.profiles itself.
-- SET search_path='': a SECURITY DEFINER function otherwise inherits the caller's schema search
--   order, which lets someone shadow a name with their own object and run it with owner power.
--   With an empty path every name must be schema-qualified (public.profiles).
-- Because the owner is not subject to RLS, these inserts and updates do not need a policy.

-- Copy only id and email. Anything from raw_user_meta_data is user-controlled, and a failing trigger would block signup.
CREATE FUNCTION public.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS
$$
BEGIN
INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email);
RETURN NEW;
END $$;

CREATE TRIGGER on_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- Keeps the copied email in step when Supabase Auth changes it. WHERE id = NEW.id limits the update to the one user whose email changed.
CREATE FUNCTION public.handle_email_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS
$$
BEGIN
UPDATE public.profiles  set email=NEW.email, updated_at = now() WHERE id = NEW.id;
RETURN NEW;
END $$;

-- UPDATE OF email: fires only when a statement touches the email column.
CREATE TRIGGER on_email_update AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_email_sync();

-- Runtime role for the API: can log in, owns nothing, bypasses nothing.
-- The password is set outside this file (\password app_user), so it is never committed.
-- The NO... attributes are the defaults, spelled out to document the intent.
CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Story 1 only reads the caller's own profile.
-- Without USAGE on the schema the role can't see the table at all. Note there's no INSERT, UPDATE or DELETE.
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON public.profiles TO app_user;

-- Row filter: the API sets app.user_id per transaction.
-- Once RLS is on, the role sees only rows a policy allows; no policy means no rows.
-- Not FORCEd: the table owner (the trigger functions) must stay exempt or signup would fail.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL when app.user_id is unset instead of raising an error,
-- and NULLIF turns an empty string into NULL so the uuid cast cannot fail on it. A NULL
-- comparison matches nothing, so a missing user context returns no rows (fails closed).
CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT TO app_user
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Defence in depth: the Data API roles get nothing, even if it is re-enabled later.
REVOKE ALL ON public.profiles FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_email_sync() FROM PUBLIC, anon, authenticated;
