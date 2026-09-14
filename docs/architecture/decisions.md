# Decisions Log

Running log of product/architecture decisions made during development, captured as Q&A so the reasoning behind each decision stays attached to it.

---

## Domain Model — Core Entities & Billing Shape

**Date:** 2026-09-07

**Q: What are the core domain entities?**

A: `User`, `Subscription`, `Billing`.

**Q: Should `Billing` be a full historical ledger (one record per billing cycle) or a single row holding just the current cycle's status?**

A: Full ledger — one `Billing` record per billing cycle (`subscription_id`, `due_date`, `amount`, `status`: due/paid, `paid_at`), not a single mutable current-cycle row.

Why: the PRD's original design kept `billing_status`, `start_date`, `renewal_date`, and `cost` as fields directly on `Subscription`, overwritten on each renewal (BR-005, BR-012). That destroys billing history on every renewal. A ledger preserves what was actually charged each cycle, which turns "expense within a period" analytics into a direct query over real historical `Billing` rows instead of a reconstruction from one current snapshot.

Resulting split: `Subscription` holds descriptive/static fields (name, category, payment_method, renewal_link, cancellation_link, auto_renews, billing_period) plus the current lifecycle `status` (active / active-unknown / inactive). Renewal confirmation closes out the current `Billing` record (sets it `paid`) and creates the next one, rather than mutating `Subscription` in place.

**Q: Should `Notification` be a fourth core domain entity?**

A: No. Notification delivery and de-duplication (needed for the "no duplicate reminder" rule, FR-051) is handled at the infrastructure level, not modeled as a domain entity. A queue may be introduced later if needed, but it isn't part of the domain model.

---

## Data Model — Payment Method & Billing Ledger Details

**Date:** 2026-09-07

**Q: Where does "payment method" live — a bare enum on `Subscription`/`Billing`, or its own entity?**

A: `PaymentMethod` is its own entity: `id`, `userId`, `type`. Append-only.

Why: a user can hold more than one instance of a type (e.g. two credit cards); a bare `credit_card` enum string can't distinguish which one was used for a given subscription or charge. `Subscription` and `Billing` reference a payment method by id instead of duplicating the type as a string.

**Q: What's the primary key and required fields for `Billing`?**

A: Primary key is `transactionId` (not a generic `id`). `Billing` also gets a `status` field (`due` / `paid`), `dueDate` and `paidAt` as two separate fields (not one combined date), and `createdAt`/`updatedAt` timestamps for consistency with the other entities.

**Q: Does `getBilling(userId, subscriptionId)` cover both "current cycle" and "full history" lookups?**

A: No — split into two functions: `getCurrentBillingCycle(subscriptionId)` for the active/most recent row, and `getBillingHistory(subscriptionId, dateRange?)` for the full ledger (needed for spend-over-a-period analytics).

**Q: Are `createBillingCycle` / `confirmPayment` exposed as directly callable operations, or internal-only?**

A: Called internally only — invoked by `Subscription`'s renewal/reactivation flows, not exposed as standalone entry points a caller invokes directly.

**Q: Is the `Billing` ledger mutable once a row is written?**

A: The ledger is immutable/append-only. Corrections after a row is settled are new rows, not edits to history.

---

## Data Model — Subscription Fields & Function Split

**Date:** 2026-09-07

**Q: Is `PaymentMethod` append-only, with no removal?**

A: No — that was a misstatement in the prior round. `PaymentMethod` supports removal, but as a soft-delete (`isActive` flag), not a hard delete or true append-only log.

Why: `Billing` rows reference `paymentMethodId` as a permanent historical record, and `Billing` is immutable. Hard-deleting a `PaymentMethod` would orphan that FK on old rows. Soft-delete keeps historical billing rows resolvable while still letting a user stop a payment method from being offered going forward — the same pattern `Subscription` already uses (`inactive` instead of deletion).

**Q: Should `Subscription` gain a `paymentMethodId` referencing the new `PaymentMethod` entity?**

A: Yes — it's the subscription's current default payment method.

**Q: Should `Subscription` keep a `billingStatus` field, mirroring the current `Billing` cycle's status?**

A: No, drop it — it's not just risky, it's redundant. Under the ledger, there is essentially always one `due` `Billing` row under an `active` subscription (the upcoming, unconfirmed cycle), whether its due date is still ahead or already passed. So a mirrored `billingStatus` would read `due` in both cases and can't distinguish anything `Subscription.status` doesn't already encode — the real signal is `Billing.dueDate` vs. today, not `Billing.status` vs. `Subscription.status`.

**Q: Should `category` and `autoRenews` be added to `Subscription`?**

A: Yes — both are required by the PRD (FR-038/BR-016 for category, BR-014/FR-036 for auto-renew) and were simply missing from the initial sketch.

**Q: Where do `startDate` and "next renewal date" live?**

A: `Subscription.startDate` is kept, but redefined as the anchor for the *current active streak* only — set at creation, reset at reactivation, and used once to seed the first `Billing` row's `dueDate`. It is **not** rewritten on every ordinary renewal confirmation. "Next renewal date" is never stored on `Subscription` — it's always read as `Billing.getCurrentBillingCycle(subscriptionId).dueDate`.

This revises `prd.md` BR-005, which currently has `start_date` rewritten on every renewal (a pre-ledger rule). **Follow-up: update `prd.md` BR-005 and the Data Requirements table** so the PRD doesn't contradict this model.

**Q: Should `updateSubscription` stay one generic function, or split by flow?**

A: Split. `updateSubscription` now only covers plain field edits (name, category, price, billing period, links, auto-renew, default payment method) and never touches `status`. Renewal, cancellation, reactivation, and the system-triggered overdue transition each get their own function (`confirmRenewal`, `confirmCancellation`, `reactivateSubscription`, `transitionOverdueSubscriptions`), since each has distinct side effects on the `Billing` ledger that don't belong in a generic update.

---

## Correction — Billing Status Transition Direction

**Date:** 2026-09-07

**Q: Which direction does a `Billing` row's status actually transition — is a row created `due` and confirmed to `paid`, or created `paid` and lapses to `due`?**

A: Created `paid`, lapses to `due`. This corrects an earlier mistake in this log and in `data-model.md`, which described `confirmPayment` flipping a row `due → paid` on user confirmation.

Re-deriving from the PRD's actual rules (BR-012/FR-031/FR-033): `billing_status` is set to `paid` on creation, on renewal confirmation, and on reactivation — i.e., a cycle starts in good standing the moment it's confirmed to exist. It only becomes `due` automatically, when its renewal date passes with no new cycle confirmed (coinciding with `active → active-unknown`). So `paid → due` is the system-triggered lapse, not a user-driven confirmation step, and a `due` (lapsed) row is never flipped back — reconciling it means starting a new `paid` row for the next cycle, not editing the old one. This also means `paidAt` is dropped as a field — a row is "paid" from the moment of `createdAt`, so a separate timestamp for it is redundant.

Renamed accordingly: `confirmPayment` → `markCycleOverdue` (internal, system-triggered, `paid → due`, the one allowed mutation). `createBillingCycle` always creates rows as `paid`.

---

## Tech Stack — Frontend Framework, Backend, Database

**Date:** 2026-09-08

**Q: React or Next.js for the frontend?**

A: Plain React (SPA), not Next.js.

Why: the project is deliberately built as a separate React frontend talking to its own Node.js REST API, rather than a Next.js app where the API layer would fold into the frontend framework. Keeping a standalone backend is itself part of the engineering-skills goal of this portfolio project (see `readme.md`'s engineering goals). This also settles a knock-on question from the auth-provider discussion: NextAuth/Auth.js is ruled out as a strong option, since it's architecturally tied to Next.js's request model; Clerk, Auth0, Firebase Auth, and Supabase Auth remain viable (all have separate React + Node SDKs suited to a split SPA/API architecture).

**Q: Backend runtime and database?**

A: Node.js (separate service from the frontend) and PostgreSQL. Both resolve `readme.md`'s previously-pending "Backend: Node.js vs Next.js API" and "Database" decisions.

---

## Authentication Provider — Supabase Auth

**Date:** 2026-09-08

**Q: Which auth provider?**

A: Supabase Auth, using the same Supabase project as the database. Resolves the "is PostgreSQL Supabase's hosted Postgres, or a separate host?" question raised earlier — it's Supabase's, so Auth and the database live together in one free-tier project rather than two unrelated services.

**Q: What does this change about the `User` entity in `data-model.md`?**

A: It directly resolves the two items that were still open there:
* Supabase Auth maintains its own `auth.users` table (id, email, credentials) in the `auth` schema of the same Postgres database. Our own `User` data becomes an app-side profile row keyed by `auth.users.id` (a UUID), not a separately-issued id — so "lookup by email" is no longer needed; requests are authenticated via Supabase's JWT, and the profile is fetched by that id directly.
* `password`/`passwordHash` and `updatePassword` are dropped from `User` entirely — Supabase Auth stores and verifies credentials itself; our schema never sees a password.
* The standard Supabase pattern is a database trigger (`handle_new_user`) that inserts a `public` profile row automatically whenever a new row appears in `auth.users`, rather than the app calling its own `createUser`.

See `data-model.md` for the updated `User` entity shape.

---

## Session/Token Handling Between the React SPA and the Node API

**Date:** 2026-09-08

**Q: How does auth actually flow between the React frontend, Supabase, and the Node.js API?**

A: Register/login/logout happen entirely between the React app and Supabase Auth directly (via `@supabase/supabase-js`), bypassing the Node.js API — Supabase issues a JWT access token (plus refresh token, managed by the client SDK). Every request from the frontend to the Node API carries that access token as a bearer token; the API verifies its signature on every request (stateless — no server-side session store) and extracts the user id from it for ownership checks. The Node API has no login/logout/register endpoints of its own.

Why: this is Supabase's standard integration pattern, and it keeps the API stateless and consistent with the project's existing "server-side authorization on every request" principle — there's no alternative session model worth inventing here.

**Follow-up:** `prd.md` (Story 1, FR-001–005) and `readme.md`'s example API endpoints have been updated to match — no `/api/v1/auth/login`/`logout`/`me` endpoints on the Node API.

---

## Notification Provider — Resend

**Date:** 2026-09-08

**Q: Which email service for notifications?**

A: Resend.

Why: best Node.js developer experience of the free options surveyed (minimal SDK, pairs with `react-email` for templating), and its free tier (3,000 emails/month, 100/day) comfortably covers this app's actual volume — creation, 5/4/3/2/1-day reminders, escalation, status-change, and one monthly summary per user. Brevo was the runner-up (higher permanent free volume, 300/day) if usage ever grows past a personal-scale app. SendGrid's free plan is retired, Postmark's free tier (100 emails/month total) is too tight to run on, and SES's free tier is only free for 12 months.

**Still open:** what triggers these sends — the background job/scheduling mechanism (e.g., Supabase `pg_cron`/scheduled Edge Functions vs. a Node-side scheduler) — is a separate, not-yet-made decision.

---

## Background Job / Scheduling Mechanism — Supabase Cron → Node API

**Date:** 2026-09-08

**Q: What triggers the scheduled work — the daily overdue-transition check (BR-006/FR-045), reminder sends, escalation sends, and the monthly summary?**

A: Supabase Cron (`pg_cron` + `pg_net`, bundled free on every Supabase tier including the free one) fires on a schedule and calls an authenticated endpoint on the Node.js API. All business logic (deciding what's due, what to send, de-duplication) lives in the Node codebase, same as every other request — the cron job is just the trigger, not where any logic runs.

Why, over the alternatives compared: it avoids GitHub Actions' documented reliability issues (undocumented delays of 5–20 minutes under load, and occasional silent skips with no error); it doesn't require the Node host to stay continuously running the way an in-process scheduler (`node-cron`) would, decoupling this from the still-open hosting decision; and it doesn't introduce a new third-party job platform (Inngest/Trigger.dev) when Supabase already provides this for free as part of a service already in use. It also avoids pushing business logic into raw SQL, which a direct `pg_net` call to Resend (skipping the Node API) would have required.

**Follow-up needed:** the Node API needs a protected internal endpoint (e.g., a shared-secret header checked against the incoming request) for Supabase Cron to call — this endpoint must not be reachable by ordinary users.

---

## Authorization Enforcement Strategy

**Date:** 2026-09-08

**Q: How does the Node API enforce that a user can only access their own data — plain application-code checks, RLS as defense-in-depth, or an enforced repository layer?**

A: Enforced repository layer. The Node API uses a single privileged Postgres connection (Supabase service-role key), but route/service code never queries tables directly — every table is only reachable through a per-entity repository module whose functions require `userId` as an argument, always applied as a `WHERE`/`AND` filter internally. There's no raw-query path available outside the repository layer, so a missing ownership check can't ship, rather than relying on every route handler remembering to add one inline. System-triggered, cross-user work (the Supabase-Cron overdue sweep) uses explicitly-named cross-user repository functions with no `userId` parameter, kept visibly separate from the user-scoped ones.

Why, over the alternatives: plain application-code checks (`WHERE user_id = ...` written inline per query) have no structural guard against a missing clause. RLS-based defense-in-depth was considered and rejected for this project specifically — its main benefit (catching a mistake nobody else reviews) matters less at single-developer, personal-app scale than its costs: Supabase's connection pooler is notoriously finicky with the session-state forwarding RLS requires, a separate privileged path is still needed anyway for cross-user system jobs, and the ownership rule would end up defined twice (SQL policies + application code) instead of once. The enforced repository layer gets most of RLS's practical safety (a forgotten check becomes a code-review/structural problem, not a silent data leak) without any of its operational cost, at the price of it being a discipline enforced by code organization rather than a database-level guarantee.

See `docs/architecture/database-design.md` ("Authorization Enforcement Strategy") for the concrete pattern.

---

## Notification Idempotency Ledger & Internal Job Endpoints

**Date:** 2026-09-08

**Q: Given no `Notification` domain entity, how is "don't double-send if a job retries" (FR-051/NFR-041) actually satisfied?**

A: A minimal `notification_log` table — an infra-level dedup ledger, not a domain entity, so this doesn't reverse the earlier "no `Notification` entity" decision. Every send is guarded by `INSERT ... ON CONFLICT (user_id, notification_type, dedup_key) DO NOTHING`; no row returned means it was already sent. See `database-design.md`.

**Q: One combined internal endpoint for all scheduled work, or separate endpoints per job?**

A: Separate — four endpoints (`transition-overdue`, `send-reminders`, `send-escalations`, `send-monthly-summary`), each with its own `pg_cron` schedule entry, authenticated by a shared secret rather than a user JWT. A failure in one shouldn't block or obscure the others, and each is independently checkable/retriable. See `api-design.md` ("Internal — Scheduled Jobs").
