# Product Requirements Document

## Subscription Manager

---

## Table of Contents

1. [Document Information](#document-information)
2. [Product Overview](#product-overview)
3. [Problem Statement](#problem-statement)
4. [Goals & Objectives](#goals--objectives)
5. [Non-Goals](#non-goals)
6. [Target Users](#target-users)
7. [User Stories](#user-stories)
8. [Functional Requirements](#functional-requirements)
9. [Subscription Lifecycle & State Machine](#subscription-lifecycle--state-machine)
10. [Business Rules](#business-rules)
11. [Data Requirements](#data-requirements)
12. [Notification Requirements](#notification-requirements)
13. [Analytics Requirements](#analytics-requirements)
14. [Non-Functional Requirements](#non-functional-requirements)
15. [Security & Privacy Requirements](#security--privacy-requirements)
16. [Error & Edge Cases](#error--edge-cases)
17. [Success Metrics](#success-metrics)
18. [Assumptions & Constraints](#assumptions--constraints)
19. [Open Questions](#open-questions)
20. [Future Scope](#future-scope)
21. [Release Scope](#release-scope)

---

# Document Information

| Field          | Value             |
| -------------- | ----------------- |
| Version        | 1.1               |
| Status         | Final             |
| Author         | Sharvari Kulkarni |
| Created        | 2026-09-07         |
| Last Updated   | 2026-09-07         |
| Target Release | V1                |

---

# Product Overview

Subscription Manager is a web application that lets a user log all of their recurring (and one-time) subscriptions in one place, track when each is due for renewal, and receive email notifications at key moments — creation, upcoming renewal, and status changes — plus a monthly spending summary.

Every subscription is created **active** by default. When a subscription reaches its renewal date without the user recording what happened (renewed vs. cancelled), it moves into an **active-unknown** state so the user is prompted to reconcile it. There is no hard delete — a subscription that is no longer wanted is marked **inactive** instead, preserving history.

---

# Problem Statement

Managing several recurring subscriptions makes it easy to lose track of:

* When a subscription is next due to renew.
* What was actually decided last time it renewed (continued vs. cancelled) — records go stale if nobody updates them.
* How much is being spent on subscriptions overall, by category, or per billing period.
* Which subscriptions are genuinely recurring vs. one-off purchases that shouldn't be tracked for renewal.

Subscription Manager centralizes this information, proactively emails the user at the moments that matter, and forces stale/undecided subscriptions into a visibly distinct state instead of silently going out of date.

---

# Goals & Objectives

## Product Goals

* Let a user record a subscription once and track it going forward.
* Make it unambiguous which subscriptions need a decision from the user right now (`active-unknown`).
* Keep subscription records accurate over time via explicit user confirmation on renewal, rather than assuming renewal happened.
* Give the user spending visibility: by time period, by category, and by recurring-vs-one-time.
* Notify the user by email at the moments they need to act or be informed (creation, upcoming renewal, status change, monthly summary).

## Non-Goals (see also [Non-Goals](#non-goals))

* Automating the renewal/cancellation decision itself.

---

# Non-Goals

V1 will **not**:

* Provide a delete operation for subscriptions — deactivation (`inactive`) is the only removal path; records are retained.
* Automatically renew or cancel a subscription with the provider.
* Process payments or store full payment card/account numbers.
* Scan email or bank accounts to auto-detect subscriptions.
* Support multiple currencies (single currency for V1 — see [Assumptions](#assumptions--constraints)).
* Support shared/household subscriptions or multiple users per subscription.

---

# Target Users

An individual who wants a single place to track their own personal subscriptions, get reminded before they renew, be forced to reconcile subscriptions that have gone past their renewal date without an update, and see what they're spending across all subscriptions.

---

# User Stories

## Story 1 — Register / Log In

As a user, I want to create an account and log in, so that my subscription data is private to me.

**Acceptance Criteria**
* User can register, log in, and log out via **Supabase Auth**, called directly from the React frontend — these steps do not go through the Node.js API.
* Every request from the frontend to the Node.js API carries the Supabase-issued access token (JWT); the API verifies it on every request and rejects missing/invalid tokens.
* All subscription data and endpoints require a valid, verified token.
* A user can only ever see and modify their own subscriptions (enforced server-side, using the user id extracted from the verified token — never trusted from client input).

---

## Story 2 — Add a Subscription

As a user, I want to add a subscription through a form, so that it's tracked going forward.

**Acceptance Criteria**
* Form fields:
  * Subscription name (required)
  * Billing period — Monthly / 6 Months / Annually (required)
  * Start date (required)
  * Renewal date — system-calculated from start date + billing period, not manually entered
  * Cost (required, > 0)
  * Payment method — one of the user's stored payment methods (Credit Card / Debit Card / Apple Pay); the user must have at least one on file to complete this step (required)
  * Renewal link (optional)
  * Cancellation link (optional)
  * Auto-renew flag — does this service renew automatically by default? (required; informational, does not change the active → active-unknown transition rule)
  * Category — e.g. Entertainment, News, Productivity, etc. (free text; the system may auto-suggest a category based on the subscription name, and the user can override it)
* On save, status defaults to `active`, and a billing cycle record is created (paid, due at `start_date + billing_period`) — see [Billing Requirements](#billing-requirements).
* User receives a confirmation email that the subscription was created ([Notification Requirements](#notification-requirements)).
* The new subscription appears in the "Active" list immediately.

---

## Story 3 — View Subscriptions by Category

As a user, I want to view my subscriptions grouped into Active / Active-Unknown / Inactive, so I can quickly see what needs my attention.

**Acceptance Criteria**
* Three list views: `active`, `active-unknown`, `inactive`.
* `active-unknown` is visually distinguished as needing action.
* Each row shows: name, cost, billing period, renewal/last-renewal date, payment method, category.
* Active list sorted by soonest renewal date first.

---

## Story 4 — Get Reminded Before Renewal

As a user, I want an email reminder in the days before a subscription renews, so I can decide whether to keep it.

**Acceptance Criteria**
* Emails are sent 5, 4, 3, 2, and 1 day(s) before the renewal date, for every `active` subscription.
* Each reminder email includes: subscription name, renewal date, cost, billing period, payment method, and the renewal link (if present).
* Reminders stop once the subscription is no longer `active` (e.g., it became `active-unknown` at the renewal date, or was already set `inactive`).
* A given subscription/day-offset pair is only emailed once (no duplicates on retries).

---

## Story 5 — Subscription Goes Unreconciled at Renewal

As the system, when a subscription's renewal date arrives and the user hasn't recorded an outcome, I want to flag it, so stale data doesn't masquerade as active.

**Acceptance Criteria**
* On the renewal date, if the user has not recorded a renewal or cancellation, status automatically transitions `active` → `active-unknown`.
* A status-change notification email is sent to the user when this transition happens ([Notification Requirements](#notification-requirements)).
* `active-unknown` subscriptions stop receiving renewal reminder emails (there's nothing upcoming to remind about until reconciled).
* `active-unknown` subscriptions are excluded from "active monthly spend" analytics until reconciled (see [Analytics Requirements](#analytics-requirements)).

---

## Story 6 — Reconcile an Active-Unknown Subscription (Renewed)

As a user, I want to tell the system a subscription renewed, so its record and next renewal date are accurate.

**Acceptance Criteria**
* User can mark an `active-unknown` (or `active`, ahead of time) subscription as "renewed."
* On confirmation:
  * A new billing cycle record is created (paid, due at the previous cycle's due date + `billing_period`) — see [Billing Requirements](#billing-requirements). The prior cycle's record, even if it had lapsed, is left as-is rather than being overwritten.
  * `cost` and `payment_method` can optionally be updated if they changed; the new value applies to the new cycle going forward.
  * Status becomes `active`.
* A status-change notification email is sent.

---

## Story 7 — Reconcile an Active-Unknown Subscription (Cancelled)

As a user, I want to tell the system I cancelled a subscription, so it stops being tracked as active.

**Acceptance Criteria**
* User can mark an `active-unknown` (or `active`) subscription as "cancelled."
* Status becomes `inactive`. The record is retained, not deleted.
* No further renewal reminders are sent for this subscription.
* A status-change notification email is sent.

---

## Story 8 — Edit Subscription Details

As a user, I want to manually update subscription details, so records stay accurate outside of the renewal flow.

**Acceptance Criteria**
* Editable fields: cost, payment method, billing period, category, renewal link, cancellation link, auto-renew flag, name.
* `start_date` and the next renewal/due date are never directly hand-edited — `start_date` is only reset via the renewal-confirmation or reactivation flows (Stories 6, 11), and the next due date always comes from the subscription's current billing cycle record, not a hand-entered field.
* Any status change made through editing triggers a status-change notification email.

---

## Story 9 — View Spending Analytics

As a user, I want to see what I'm spending on subscriptions, so I can make informed decisions.

**Acceptance Criteria**
* User can view total spend across a selected date range.
* User can view spend broken down by category (Entertainment, News, etc.).
* User can view a breakdown of one-time vs. recurring subscriptions.
* `active-unknown` subscriptions are visually called out in analytics as "pending reconciliation" rather than silently included/excluded.

---

## Story 10 — Monthly Analytics Email

As a user, I want a monthly summary email, so I don't have to log in to know what I spent.

**Acceptance Criteria**
* Sent on the 1st of every calendar month.
* Includes: total active recurring spend (monthly-normalized), spend by category, count of subscriptions by status, and any subscriptions currently `active-unknown`.

---

## Story 11 — Reactivate an Inactive Subscription

As a user, I want to reactivate a subscription I previously cancelled, so that re-subscribing to the same service doesn't force me to re-enter everything from scratch.

**Acceptance Criteria**
* Re-subscribing to a service the user previously tracked is modeled as **reactivating the existing `inactive` record**, not creating a new one.
* Reactivation reuses the old record's details — name, category, payment method, renewal link, cancellation link, auto-renew flag — by default.
* The user must supply/confirm the current `start_date`, and may update `cost` and `billing_period` if they changed.
* A new billing cycle record is created for the reactivated subscription (paid, due at the confirmed `start_date + billing_period`) — see [Billing Requirements](#billing-requirements).
* On reactivation, status becomes `active`.
* A status-change notification email is sent.

---

## Story 12 — Manage Stored Payment Methods

As a user, I want to add and remove payment methods, so I can pick from them when creating or editing a subscription.

**Acceptance Criteria**
* User can add a payment method (Credit Card / Debit Card / Apple Pay).
* User can remove a payment method they no longer want offered. Removing it does not affect subscriptions or billing history that already reference it — it just stops appearing as a choice for new/future selections.
* A user must have at least one payment method on file before creating a subscription (Story 2).

---

# Functional Requirements

## Authentication

* **FR-001**: The system shall allow a user to create an account via Supabase Auth, called directly from the frontend. A corresponding app-side profile record is created automatically (via a database trigger) when the account is created — not by the Node.js API.
* **FR-002**: The system shall allow a user to log in via Supabase Auth, called directly from the frontend, receiving a Supabase-issued access token (JWT).
* **FR-003**: The system shall allow a user to log out via Supabase Auth, called directly from the frontend.
* **FR-004**: The Node.js API shall verify the Supabase-issued access token on every request and reject requests with a missing or invalid token (401). The API itself does not implement its own login/logout endpoints.
* **FR-005**: The system shall enforce that a user can only read/write their own subscriptions, using the user id extracted from the verified token as the source of truth for ownership checks — never a client-supplied id.

## Subscription Creation

* **FR-010**: The system shall allow an authenticated user to create a subscription via a form capturing: name, billing period, start date, cost, payment method (selected from the user's stored payment methods), renewal link (optional), category.
* **FR-011**: The system shall create a billing cycle record due at `start_date + billing_period` as part of creating a subscription; this due date is never directly user-entered (see [Billing Requirements](#billing-requirements)).
* **FR-012**: The system shall set a new subscription's status to `active` by default.
* **FR-013**: The system shall send a "subscription created" email on successful creation.

## Subscription Read

* **FR-020**: The system shall allow a user to list subscriptions filtered by status: `active`, `active-unknown`, `inactive`.
* **FR-021**: The system shall allow a user to view the full details of a single subscription.

## Subscription Update

* **FR-030**: The system shall allow a user to edit: name, cost, payment method, billing period, category, renewal link, cancellation link, auto-renew flag. Editing these fields shall not change `status` or write to billing history.
* **FR-031**: The system shall allow a user to explicitly confirm a renewal, which creates a new billing cycle record (paid, due at the prior cycle's due date + `billing_period`) and optionally updates `cost`/`payment_method` for that new cycle going forward. The prior cycle's record is left unchanged, even if it had lapsed.
* **FR-032**: The system shall allow a user to explicitly confirm a cancellation, which sets status to `inactive`. No new billing cycle record is created.
* **FR-033**: The system shall automatically transition status from `active` to `active-unknown` when the renewal date passes without a recorded outcome, and shall mark the subscription's current billing cycle record as lapsed (`due`) at the same time.
* **FR-034**: The system shall send a "status changed" email whenever a subscription's `status` value changes, regardless of whether the change was user-initiated or system-initiated. Edits that do not change the `status` value do not trigger this email.
* **FR-035**: The system shall maintain a billing cycle status (`paid` / `due`) per cycle via the billing ledger, not as a single field on the subscription itself — see [Billing Requirements](#billing-requirements).
* **FR-036**: The system shall allow a user to record an `auto_renews` flag reflecting whether the service provider renews automatically by default. This flag is informational and does not alter the `active → active-unknown` transition rule (FR-033) — the system always requires explicit user confirmation.
* **FR-037**: The system shall allow a user to store an optional cancellation link, separate from the renewal link.
* **FR-038**: The system may auto-suggest a `category` value based on the subscription name; the user may always override it with free text.

## Subscription Reactivation

* **FR-039**: The system shall allow a user to reactivate an `inactive` subscription rather than requiring a new record. Reactivation shall reuse the existing record's `name`, `category`, `payment_method`, `renewal_link`, `cancellation_link`, and `auto_renews` by default, while requiring the user to confirm/supply a current `start_date` and allowing updates to `cost` and `billing_period`. A new billing cycle record is created (paid, due at the confirmed `start_date + billing_period`), and `status` becomes `active`.

## Subscription Delete

* **FR-040**: The system shall not provide a hard-delete operation for subscriptions. The only way to stop tracking a subscription as active is to set it `inactive`.

## Payment Methods

* **FR-041**: The system shall allow a user to add a payment method (`credit_card` / `debit_card` / `apple_pay`).
* **FR-042**: The system shall allow a user to remove a payment method. Removal shall not delete or invalidate subscriptions or billing history that reference it — it only stops the method from being offered for future selection.
* **FR-043**: The system shall require a user to have at least one payment method on file before creating a subscription.

## Billing Requirements

* **FR-044**: The system shall create a billing cycle record, marked `paid`, whenever a subscription is created, a renewal is confirmed, or a subscription is reactivated. Each record captures the amount, payment method, and due date for that cycle.
* **FR-045**: The system shall automatically mark a billing cycle record `due` (lapsed) when its due date passes without a new cycle having been confirmed, coinciding with the subscription's `active → active-unknown` transition (FR-033).
* **FR-046**: The system shall never edit a billing cycle record after it is created, beyond the single `paid → due` lapse transition (FR-045). Corrections are new records, not edits to history.
* **FR-047**: The system shall allow a user to view the full billing history for a subscription.

## Notifications

* **FR-050**: The system shall send renewal-reminder emails 5, 4, 3, 2, and 1 day(s) before an `active` subscription's renewal date.
* **FR-051**: The system shall not send duplicate reminder emails for the same subscription and day-offset.
* **FR-052**: The system shall send a monthly analytics email to each user on the 1st of every month.
* **FR-053**: The system shall send escalating reminder emails for a subscription that remains `active-unknown` beyond its initial status-change notification, on a recurring cadence, until the user reconciles it (renew or cancel).

## Analytics

* **FR-060**: The system shall calculate total subscription spend over a user-specified date range.
* **FR-061**: The system shall calculate spend grouped by category.
* **FR-062**: The system shall distinguish and report one-time vs. recurring subscriptions.
* **FR-063**: The system shall normalize spend across differing billing periods (monthly / 6-month / annual) for comparison (e.g. monthly-equivalent cost).

---

# Subscription Lifecycle & State Machine

```text
                    ┌────────────────────────┐
                    │        active          │◀────────────┐
                    └───────────┬────────────┘              │
                                │                            │
                renewal date reached,                        │
                no user action recorded                 user confirms
                                │                          "renewed"
                                ▼                            │
                    ┌────────────────────────┐               │
                    │    active-unknown      │───────────────┘
                    │  (escalating reminders │
                    │   until reconciled)    │
                    └───────────┬────────────┘
                                │
                     user confirms "cancelled"
                                │
                                ▼
                    ┌────────────────────────┐
                    │       inactive         │
                    └───────────┬────────────┘
                                │
                     user reactivates (reuses
                     old record's details)
                                │
                                ▼
                        back to `active`
                     (same record, not a new one)
```

Notes:

* The `active → active-unknown` transition is system-triggered (date-based), not user-triggered. The subscription's current billing cycle record is marked lapsed (`due`) at the same moment.
* Both resolutions of `active-unknown` (renew / cancel) are strictly user-triggered — the system never assumes an outcome.
* While `active-unknown`, the subscription receives escalating reminder emails on a recurring cadence until the user reconciles it (see [Notification Requirements](#notification-requirements)).
* `inactive` is **not** terminal: re-subscribing to a previously cancelled service is modeled as **reactivating the same record** (Story 11 / FR-039), reusing its historical details (name, category, payment method, renewal link, cancellation link, auto-renew flag) rather than creating a new record. Only `start_date` (and optionally `cost`/`billing_period`) need to be reconfirmed.

---

# Business Rules

**BR-001**: A subscription always belongs to exactly one user; users cannot access each other's subscriptions.

**BR-002**: Status must be exactly one of: `active`, `active-unknown`, `inactive`.

**BR-003**: A subscription's next due date is always derived, never hand-entered: `start_date + billing_period` for the first billing cycle, and the prior cycle's due date + `billing_period` for every cycle after that. This value lives on the billing ledger (see [Billing Requirements](#billing-requirements)), not as a field on the subscription itself.

**BR-004**: Billing period must be one of: `monthly`, `6_months`, `annually`.

**BR-005**: On renewal confirmation, a new billing cycle record is created for the next period; `start_date` on the subscription itself is **not** rewritten on ordinary renewal — it only resets when a subscription is reactivated after being `inactive` (BR-013). *(Revised: earlier drafts of this PRD had `start_date` rewritten on every renewal; superseded once billing history moved to its own ledger — see `docs/architecture/decisions.md`.)*

**BR-006**: A subscription transitions to `active-unknown` automatically at end-of-day on its current billing cycle's due date if no renewal/cancellation has been recorded by then.

**BR-007**: Renewal reminder emails (5/4/3/2/1 days) are only generated for subscriptions currently `active`.

**BR-008**: Every status change (system- or user-triggered) generates exactly one "status changed" notification.

**BR-009**: There is no operation that permanently deletes a subscription record. `inactive` means "not currently tracked as active," but the record persists and can be reactivated (BR-013).

**BR-010**: Payment method must be one of: `credit_card`, `debit_card`, `apple_pay`.

**BR-011**: Cost must be greater than zero and expressed in the account's single supported currency ([Assumptions](#assumptions--constraints)).

**BR-012**: A billing cycle record's status must be exactly one of: `paid`, `due`. It is created `paid` — creation of the record itself is the confirmation, there is no separate pending state. It becomes `due` (lapsed) only automatically, when its due date passes without a new cycle having been confirmed (coinciding with the `active → active-unknown` transition). A `due` record is never flipped back to `paid`; reconciling it means creating a new `paid` record for the next cycle, not editing the old one. This status lives on the billing ledger, not as a `Subscription` field (BR-021).

**BR-013**: Reactivating an `inactive` subscription reuses its existing `name`, `category`, `payment_method`, `renewal_link`, `cancellation_link`, and `auto_renews` values. The user reconfirms `start_date` (which resets the anchor for this new active streak) and may update `cost`/`billing_period`. A new billing cycle record is created, due at `start_date + billing_period`. Status becomes `active`.

**BR-014**: `auto_renews` records whether the provider renews automatically by default. It is informational only — it does not change BR-006 (the system always requires explicit user confirmation before treating a renewal as resolved).

**BR-015**: `cancellation_link` is optional and independent of `renewal_link`.

**BR-016**: `category` may be auto-suggested by the system based on the subscription name, but is stored as free text and can always be overridden by the user.

**BR-017**: A subscription is treated as `one_time` (`subscription_type`) when no billing period/renewal date is supplied **and** the user explicitly confirms it is a one-time purchase. The system does not silently infer `one_time` from missing data alone.

**BR-018**: A subscription that remains `active-unknown` beyond its initial status-change notification receives escalating reminder emails on a recurring cadence (default: every 3 days — see [Assumptions](#assumptions--constraints)) until the user reconciles it.

**BR-019**: A payment method has no hard delete. Removing one is a soft-delete — it stops being offered for new selections, but subscriptions and billing history that already reference it are unaffected. (Hard-deleting would orphan historical billing records that reference it.)

**BR-020**: A subscription's payment method is a reference to one of the user's stored payment methods, not a bare type value — this allows the user to distinguish between multiple instances of the same type (e.g., two credit cards).

**BR-021**: The billing ledger is append-only/immutable: once a billing cycle record is created, its only permitted change is the single `paid → due` lapse transition (BR-012). Corrections after that are new records, never edits to existing ones.

---

# Data Requirements

## User

* User identifier — same id as Supabase Auth's `auth.users.id`
* Email (for login and for receiving all notification emails)
* Authentication credentials are owned entirely by Supabase Auth; the application never stores them
* Account creation timestamp

## Subscription

| Field            | Source                             | Notes                                                                                   |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| id               | system                              |                                                                                             |
| user_id          | system                              | owner                                                                                       |
| name             | user (form)                         |                                                                                             |
| category         | user (form, free text) / system-suggested | e.g. Entertainment, News, Productivity — used for analytics grouping; system may suggest a value from `name`, user can override |
| billing_period   | user (form, optional)               | `monthly` \| `6_months` \| `annually`; omitted only when `subscription_type` is `one_time` |
| start_date       | user (form) / system (on reactivation) | anchor for the *current active streak* only — seeds the first billing cycle's due date; not rewritten on ordinary renewal (BR-005) |
| cost             | user (form)                         | > 0, single currency — the currently agreed price, carried into the next billing cycle record |
| payment_method_id | user (form)                        | references a record in [Payment Method](#payment-method) — the subscription's current default |
| renewal_link     | user (form, optional)               |                                                                                             |
| cancellation_link | user (form, optional)              |                                                                                             |
| auto_renews      | user (form)                         | boolean; reflects the provider's default renewal behavior; informational (BR-014)          |
| status           | system / user                       | `active` \| `active-unknown` \| `inactive`                                                 |
| subscription_type | system (inferred + user-confirmed) | `recurring` \| `one_time` — `one_time` requires absence of a billing period **and** explicit user confirmation (BR-017) |
| created_at       | system                              |                                                                                             |
| updated_at       | system                              |                                                                                             |

There is no `billing_status` or `renewal_date` field on `Subscription` — both live on the billing ledger instead (see [Billing](#billing) below), which is the single source of truth for per-cycle status and due dates (BR-012, BR-021).

V1 will **not** store payment card numbers, CVVs, or bank account numbers — only the payment method type.

## Payment Method

| Field     | Source          | Notes                                        |
| --------- | --------------- | ----------------------------------------------- |
| id        | system          |                                                   |
| user_id   | system          | owner                                             |
| type      | user (form)     | `credit_card` \| `debit_card` \| `apple_pay`        |
| is_active | system / user   | soft-delete flag; `false` once removed (BR-019)    |
| created_at | system         |                                                   |
| updated_at | system         |                                                   |

A user may store more than one payment method, including more than one of the same type (BR-020). Removing one never hard-deletes it (BR-019).

## Billing

| Field            | Source                     | Notes                                                              |
| ---------------- | --------------------------- | --------------------------------------------------------------------- |
| transaction_id   | system                       | primary key                                                            |
| subscription_id  | system                       |                                                                         |
| user_id          | system                       |                                                                         |
| amount           | system (copied from `Subscription.cost` at cycle-creation time) |                                       |
| payment_method_id | system (copied from `Subscription.payment_method_id`, optionally updated at renewal) |                       |
| status           | system                       | `paid` \| `due` — `due` means lapsed/overdue, not "awaiting initial payment" (BR-012) |
| due_date         | system-calculated           | see BR-003                                                             |
| created_at       | system                       | also the moment a record became `paid`                                |
| updated_at       | system                       | reflects when a record lapsed to `due`, if it did                      |

One record exists per billing cycle, created whenever a subscription is created, renewed, or reactivated (FR-044). This is a full historical ledger, not a single mutable record per subscription — see BR-021 and `docs/architecture/decisions.md`.

---

# Notification Requirements

All notifications are delivered by email.

| Trigger                                             | Recipient | Timing                                   |
| ---------------------------------------------------- | --------- | ------------------------------------------ |
| Subscription created                                  | Owner     | Immediately on creation                    |
| Upcoming renewal                                      | Owner     | 5, 4, 3, 2, and 1 day(s) before the current billing cycle's due date, for `active` subscriptions only |
| Status changed (`active`↔`active-unknown`↔`inactive`, including reactivation) | Owner | Immediately on transition, only when the `status` value itself changes (BR-008) |
| Active-unknown escalation                             | Owner     | Recurring cadence (default every 3 days) while a subscription remains `active-unknown`, until reconciled (BR-018) |
| Monthly analytics summary                             | Owner     | 1st of every calendar month                |

Each notification shall:
* Identify the subscription by name.
* Avoid duplicate delivery for the same trigger instance (e.g., the same day-offset reminder is not re-sent).
* Not require the user to be logged in to receive it.

Delivery is via **Resend**. Scheduled sends (reminders, escalation, monthly summary) and the daily overdue-transition check (BR-006) are triggered by Supabase Cron calling a protected endpoint on the Node.js API — see `docs/architecture/decisions.md`.

---

# Analytics Requirements

Spend calculations are computed from the billing ledger (actual per-cycle records), not a single current-cost field, so historical spend remains accurate even after a subscription's price changes.

* **Spend over a period**: total cost of subscriptions active within a user-specified date range, normalized to a common period (e.g., monthly-equivalent) so `monthly` / `6_months` / `annually` subscriptions are comparable.
* **Spend by category**: total/average spend grouped by the subscription's `category` field.
* **One-time vs. recurring**: count and total spend split by `subscription_type`.
* **Status breakdown**: count of subscriptions in `active`, `active-unknown`, `inactive`.
* `active-unknown` subscriptions are flagged distinctly in analytics output rather than silently folded into active or inactive totals, since their real status is not yet confirmed.

---

# Non-Functional Requirements

Matches the categories used in `docs/product/prd.md` for consistency between the two documents.

## Performance

**NFR-001:** Authenticated dashboard requests should return within `[TBD]` under normal operating conditions.

**NFR-002:** The application should remain responsive during normal user interaction.

Performance targets will be refined after initial implementation and measurement.

## Availability

**NFR-010:** The application should be available during normal operating conditions.

Availability targets are `[TBD]` based on the selected deployment architecture.

## Scalability

**NFR-020:** The architecture should allow future scaling without requiring a complete rewrite of core application functionality.

The application should not introduce infrastructure complexity unless justified by an actual requirement.

## Maintainability

**NFR-030:** The application shall use modular components with clearly defined responsibilities.

**NFR-031:** Changes to one functional area should minimize unnecessary impact on unrelated functionality.

**NFR-032:** Significant architectural decisions shall be documented.

## Reliability

**NFR-040:** The status-transition job (`active → active-unknown`) must run at least once daily so no subscription goes more than ~24 hours past its renewal date without transitioning.

**NFR-041:** Notification delivery (including reminders, status-change, escalation, and monthly-summary emails) should be idempotent — retries must not produce duplicate emails for the same trigger instance.

---

# Security & Privacy Requirements

* **SEC-001**: A user may only access their own subscriptions and notifications.
* **SEC-002**: Authentication credentials must be handled using established, non-custom security mechanisms.
* **SEC-003**: All user input (form fields, date ranges for analytics) must be validated server-side.
* **SEC-004**: No full payment card/account numbers are collected or stored — only a payment method type.
* **SEC-005**: Secrets (email provider credentials, DB credentials, etc.) must never be committed to source control.
* **SEC-006**: Emails must not leak one user's subscription data to another user (correct recipient resolution, no cross-user data in templates).

---

# Error & Edge Cases

* Renewal date falls on an edge case (e.g., billing period is annual and start date is Feb 29 on a non-leap year) — resolved: clamp to the last valid day of the target month (e.g., Feb 28). See `docs/architecture/low-level-design.md`.
* User edits `cost` or `payment_method` on a subscription that is currently `active-unknown` — allowed, but does not by itself resolve the `active-unknown` state (only explicit renew/cancel confirmation does).
* User confirms "renewed" on a subscription that is still `active` (i.e., ahead of the actual renewal date) — allowed, effectively an early renewal.
* Email delivery fails (provider outage) — resolved: retried on the next scheduled job run (daily), not an in-process retry loop. See `docs/architecture/low-level-design.md`.
* Two reminder emails for the same subscription would fall on the same calendar day (e.g., very short billing periods) — de-duplication rule needed if billing periods shorter than 5 days are ever supported (not in V1's supported list, so currently N/A).
* Monthly analytics email when the user has zero subscriptions — resolved: suppressed entirely, not sent. See `docs/architecture/low-level-design.md`.

---

# Success Metrics

* User can add a subscription and immediately see it in the Active list and receive a confirmation email.
* No subscription silently stays `active` past its renewal date without either a reminder trail or a transition to `active-unknown`.
* User can answer "what am I spending on subscriptions this month, by category" from the analytics view without manual calculation.
* Monthly summary email reliably arrives on the 1st.

---

# Assumptions & Constraints

* Single currency for V1 — no multi-currency support.
* `category` is free text, optionally auto-suggested by the system from the subscription name; not a fixed enum.
* `subscription_type` (`recurring` vs. `one_time`) is set when the user omits a billing period **and** explicitly confirms the subscription is one-time (BR-017) — it is never silently inferred.
* The renewal-reminder schedule (5/4/3/2/1 days) applies only to `recurring` subscriptions; `one_time` subscriptions have no renewal date and are excluded from reminders.
* The `active-unknown` escalation cadence defaults to every 3 days until reconciled; the exact interval is a tunable default, not a hard requirement.
* Notification delivery provider/timezone handling is an architecture decision, deferred.

---

# Open Questions

All previously open questions have been resolved and folded into the relevant sections above. Kept here as a decision log:

1. **"Subscription period" (form field b) vs. "billing period" (form field f)** — confirmed to be the same field: `billing_period`.
2. **Is `category` fixed or free text?** — Free text; the system may auto-suggest a value based on the subscription name, but the user can always override it (BR-016).
3. **How is a "one-time subscription" defined?** — By the absence of a billing period/renewal date **and** explicit confirmation from the user; the system never silently infers it from missing data alone (BR-017).
4. **Should `active-unknown` have an escalation path?** — Yes. Escalating reminder emails are sent on a recurring cadence until the subscription is reconciled (BR-018, FR-053).
5. **Is re-subscribing to an `inactive` service a new record or a reactivation?** — Reactivation. The existing record is reused, including its historical details (name, category, payment method, links, auto-renew flag); only `start_date` (and optionally `cost`/`billing_period`) are reconfirmed (BR-013, Story 11).
6. **Does "status changed" apply to every edit or only actual status-value transitions?** — Only actual `status` value changes trigger the notification (BR-008, FR-034).
7. **What happens to the monthly analytics email when a user has no subscriptions at all?** — Suppressed entirely; no email sent. See `docs/architecture/low-level-design.md`.

No open questions remain.

---

# Future Scope

* User-configurable reminder schedule (currently fixed at 5/4/3/2/1 days).
* User-configurable escalation cadence for `active-unknown` subscriptions (currently fixed default of every 3 days).
* Multi-currency support.
* Additional billing periods (e.g., weekly, quarterly).
* Shared/household subscriptions.
* Push/SMS notification channels in addition to email.
* **Automated subscription discovery via email scanning**: optionally connect an email account so the system can scan for subscription-related emails and suggest subscriptions to add, as a complement to — not a replacement for — manual form entry. Suggested subscriptions would require explicit user review/confirmation before being created (consistent with V1's principle that the system never silently assumes an outcome — BR-006, BR-017). This remains a non-goal for V1 (see [Non-Goals](#non-goals)) and requires additional privacy/security analysis before being scheduled.

---

# Release Scope

## V1 — Included

* Registration, login, logout.
* Create subscription via form (name, billing period, start date, cost, payment method, renewal link, category); creates the first billing cycle record.
* Read subscriptions grouped by `active` / `active-unknown` / `inactive`.
* Update: status transitions (renew/cancel confirmation, creating new billing cycle records rather than rewriting dates in place), price, payment method, category, renewal link, name.
* Manage stored payment methods (add / soft-delete).
* View billing history for a subscription.
* No hard delete — `inactive` (subscriptions) / soft-delete (payment methods) only; billing records are never deleted or edited.
* Email notifications: creation, renewal reminders (5/4/3/2/1 days), status change, monthly analytics summary (1st of month).
* Analytics: spend over a period, spend by category, one-time vs. recurring breakdown.

## V1 — Excluded

* Payment processing / storing full payment credentials.
* Automatic cancellation or renewal with the provider.
* Email/bank scanning for auto-detected subscriptions.
* Multi-currency, multi-user/shared subscriptions.
* Hard delete of subscription records.
* User-configurable notification schedules.
