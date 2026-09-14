# Data Model

## Subscription Manager

This document sketches entity properties and functions ahead of implementation. It builds on `docs/product/prd.md` (v1.1, final) and `docs/architecture/decisions.md`.

**Status:** All four entities are resolved and match `prd.md` v1.1. `User` is built around Supabase Auth (see `decisions.md`, "Authentication Provider — Supabase Auth").

---

## 1. User

Supabase Auth owns credentials and identity in its own `auth.users` table (in the `auth` schema of the same Postgres database) — `id` (UUID), `email`, password hash, etc. Our app never sees or stores a password. `User` here is an app-side **profile** row, one-to-one with `auth.users`, sharing its primary key.

| Property   | Type      | Notes                                                                 |
| ---------- | --------- | ------------------------------------------------------------------------ |
| id         | uuid (PK) | same value as `auth.users.id` — not separately generated                  |
| name       | string    |                                                                            |
| email      | string    | denormalized copy of `auth.users.email`, kept in sync for convenience (notification sends, list views) without joining into the `auth` schema |
| createdAt  | datetime  |                                                                            |
| updatedAt  | datetime  |                                                                            |

Dropped from the original sketch: `password` (Supabase Auth handles credentials entirely) and the standalone `paymentMethod` field (now its own entity, below).

### Functions

* `getProfile(userId)` — `userId` is the Supabase Auth UUID from the verified JWT, not a separately looked-up value; there is no `getUserByEmail`, since requests are never authenticated by email lookup.
* `updateName(userId, name)`.
* Profile creation is **not** an app-called function — the standard Supabase pattern is a `handle_new_user` database trigger that inserts a profile row automatically whenever Supabase Auth creates a new `auth.users` row (on sign-up). There's no `createUser`/`updatePassword`/`updateEmail` on the app side: sign-up, login, password changes, and email changes all go through Supabase Auth's own APIs, not this entity. If `email` ever drifts out of sync, a second trigger (on `auth.users` update) refreshes the denormalized copy.

No delete function — matches the PRD not requiring account deletion in V1.

---

## 2. Subscription

**Status:** Resolved — see `decisions.md` ("Data Model — Subscription Fields & Function Split").

| Property         | Type      | Notes                                                                 |
| ---------------- | --------- | ------------------------------------------------------------------------ |
| id               | id (PK)   |                                                                            |
| userId           | id (FK)   | owner                                                                     |
| name             | string    |                                                                            |
| category         | string    | free text; system may suggest a value from `name` (BR-016)                |
| price            | number    | current agreed cost — copied into the next `Billing` row on creation/renewal/reactivation |
| billingPeriod    | enum      | `monthly` \| `6_months` \| `annually`; optional, omitted only when `subscriptionType` is `one_time` |
| subscriptionType | enum      | `recurring` \| `one_time` (BR-017)                                         |
| startDate        | date      | anchor for the *current active streak* — set at creation and reset at reactivation; **not** rewritten on ordinary renewal (see note below) |
| paymentMethodId  | id (FK)   | references `PaymentMethod` — current default                              |
| renewalLink      | string    | optional                                                                   |
| cancellationLink | string    | optional                                                                   |
| autoRenews       | boolean   | informational only (BR-014)                                               |
| status           | enum      | `active` \| `active-unknown` \| `inactive`                                 |
| createdAt        | datetime  |                                                                            |
| updatedAt        | datetime  |                                                                            |

Dropped from the original sketch: `billingStatus` (redundant with `status` — see reasoning below) and `renewalDate` (always read from `Billing.getCurrentBillingCycle(subscriptionId).dueDate`, never stored here).

**Why `billingStatus` is dropped, not cached:** under the ledger, there is essentially always one `due` `Billing` row sitting under an `active` subscription — the upcoming, unconfirmed cycle. That's true whether its due date is days away (fine) or overdue (should be `active-unknown`). A mirrored `billingStatus` field would read `due` in both cases — it can't distinguish anything `Subscription.status` doesn't already encode, since the real signal is `Billing.dueDate` vs. today, not `Billing.status` vs. `Subscription.status`. Code that needs the literal per-cycle payment status reads `Billing` directly.

**Why `startDate` isn't rewritten on renewal (revises PRD BR-005):** the pre-ledger PRD has `start_date` rewritten to the renewal date on every confirmation (BR-005), because it was the only place tracking "when did the current cycle start." Under the ledger, each new `Billing` row's `dueDate` chains off the *previous* row's `dueDate` — `Subscription.startDate` is only ever read once, to seed the very first row of a streak (at creation or reactivation). Rewriting it on every ordinary renewal is no longer necessary. **This needs a follow-up edit to `prd.md` BR-005** so the PRD doesn't contradict this model.

### Functions

* `createSubscription(subscription)` — also seeds the first `Billing` row via the internal `createBillingCycle`.
* `getSubscriptions(userId, status?)` — replaces the bare `getSubscriptions()`; supports the three status-filtered list views (FR-020, Story 3).
* `getSubscriptionById(subscriptionId)` — replaces the overloaded `getSubscriptions(subscriptionId)`.
* `updateSubscription(subscriptionId, {name?, category?, price?, billingPeriod?, renewalLink?, cancellationLink?, autoRenews?, paymentMethodId?})` — plain field edits only; does **not** touch `status` or trigger `Billing` writes.
* `confirmRenewal(subscriptionId, {price?, paymentMethodId?})` — sets `status` to `active`; internally calls `Billing.createBillingCycle` for the next cycle. The prior row (which may be `due`/overdue) is left untouched as history, not flipped back to `paid` (BR-005/FR-031, revised per above).
* `confirmCancellation(subscriptionId)` — sets `status` to `inactive` (FR-032). No `Billing` write — the last row (possibly already `due`) stands as the final historical record.
* `reactivateSubscription(subscriptionId, {startDate, price?, billingPeriod?})` — reuses stored `name`/`category`/`paymentMethodId`/links/`autoRenews`; sets `status` to `active`; internally calls `Billing.createBillingCycle` for the new first cycle (FR-039).
* `transitionOverdueSubscriptions()` — **system-triggered**, not user-invoked. Runs on a schedule (NFR-040); sets `status` to `active-unknown` and calls `Billing.markCycleOverdue` on the current row, for any `active` subscription whose current `Billing` row's `dueDate` has passed without a new cycle being confirmed (BR-006).

No delete — `inactive` is the removal path (BR-009).

---

## 3. Billing

**Status:** Resolved — see `decisions.md` ("Data Model — Payment Method & Billing Ledger Details").

| Property       | Type      | Notes                                          |
| -------------- | --------- | ------------------------------------------------ |
| transactionId  | id (PK)   | primary key                                       |
| subscriptionId | id (FK)   |                                                    |
| userId         | id (FK)   |                                                    |
| amount         | number    | (was `price`)                                     |
| paymentMethodId | id (FK)  | references `PaymentMethod` — see entity below     |
| status         | enum      | `paid` \| `due` — `due` means **overdue/lapsed**, not "awaiting initial payment" (see note) |
| dueDate        | date      | when this cycle is due                            |
| createdAt      | datetime  | also the moment this row became `paid` — see note |
| updatedAt      | datetime  | reflects when a row flipped to `due`, if it did     |

**Status semantics (matches PRD BR-012):** a row is created `paid` immediately — creation *is* the confirmation, there's no separate pending state. It only ever changes to `due` automatically, if its `dueDate` passes without a new cycle having been started. A `due` row is never flipped back to `paid`; reconciling it means creating a brand-new `paid` row for the next cycle, leaving the old one as an honest historical record that it lapsed. (No `paidAt` field — redundant with `createdAt` under this model.)

### Functions

* `getCurrentBillingCycle(subscriptionId)` — the active/most recent row.
* `getBillingHistory(subscriptionId, dateRange?)` — full ledger, needed for spend-over-a-period analytics (FR-060/061/063).
* `createBillingCycle(subscriptionId, dueDate, amount, paymentMethodId)` — **internal only**. Always creates the row as `paid`. Invoked by `Subscription`'s create (first cycle), `confirmRenewal` (next cycle — the prior row, overdue or not, is left untouched), and `reactivateSubscription` (fresh cycle).
* `markCycleOverdue(transactionId)` — **internal only**, invoked by `transitionOverdueSubscriptions` (system-triggered). This is the one allowed mutation on a row (`paid` → `due`); once `due`, the row is frozen.

No public update/delete. Corrections after a row lapses are new rows, not edits to history (immutable ledger).

---

## 4. PaymentMethod

**Status:** Resolved — see `decisions.md` ("Data Model — Subscription Fields & Function Split").

| Property  | Type     | Notes                                        |
| --------- | -------- | ----------------------------------------------- |
| id        | id (PK)  |                                                   |
| userId    | id (FK)  | owner                                             |
| type      | enum     | `credit_card` \| `debit_card` \| `apple_pay`       |
| isActive  | boolean  | default `true`; soft-delete flag (see reasoning below) |
| createdAt | datetime |                                                   |
| updatedAt | datetime |                                                   |

Not append-only, and not hard-deletable either: `Billing` rows reference `paymentMethodId` as a permanent historical record, and `Billing` is immutable. Hard-deleting a `PaymentMethod` would orphan that FK on old rows. So "removing" a payment method is a soft-delete (`isActive = false`), consistent with how `Subscription` already handles removal via `inactive` rather than a real delete.

### Functions

* `createPaymentMethod(userId, type)`
* `getPaymentMethods(userId, activeOnly?)`
* `deactivatePaymentMethod(paymentMethodId)` — soft-delete; does not affect historical `Billing` rows that reference it.

---

## Consolidated List of Open Questions

All items from the `Subscription`/`Billing`/`PaymentMethod` negotiation are resolved — see `decisions.md` for the full Q&A trail, including the mid-course correction on which direction a `Billing` row's status transitions (created `paid`, lapses to `due`; not the reverse):
* Payment method entity shape and removal semantics (soft-delete via `isActive`, not append-only, not hard-deletable).
* `Billing` primary key/status/`dueDate`/timestamps, read-function split, internal-only write functions, ledger immutability, and the `paid`-created/`due`-lapses direction (no `paidAt` field).
* `Subscription`: dropped `billingStatus` and `renewalDate`; added `category`, `autoRenews`, `paymentMethodId`; `startDate` redefined as a per-streak anchor; split into `confirmRenewal` / `confirmCancellation` / `reactivateSubscription` / `transitionOverdueSubscriptions`, with `updateSubscription` left for plain field edits only.

`prd.md` (now v1.1) has been updated to match this document — BR-005/BR-012/BR-013 revised, BR-019–021 added, FR-041–047 (Payment Methods, Billing Requirements) added, and the Data Requirements tables updated with `Payment Method` and `Billing` sections.

`User`'s two remaining items (email lookup, password storage) are now resolved by adopting Supabase Auth — see the `User` section above and `decisions.md` ("Authentication Provider — Supabase Auth"). All entities in this document are final.

**Not yet done:** `prd.md` still describes login/registration in generic terms (FR-001–005, Story 1) without naming Supabase Auth specifically. Worth a follow-up pass once the auth integration details (session/token handling between the React SPA and the Node API) are worked out.
