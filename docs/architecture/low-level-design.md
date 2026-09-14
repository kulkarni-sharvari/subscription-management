# Low-Level Design

## Subscription Manager

Fills in the remaining Phase 4 items that `database-design.md` and `api-design.md` didn't already cover: backend module structure, a consolidated validation catalog, error-handling strategy, transaction boundaries, and the end-to-end notification workflow (which also resolves three edge cases the PRD had left `[TBD]`).

---

## Backend Module Structure

```text
src/
  index.ts                    -- server bootstrap
  config/                     -- env var loading; fails fast on missing/invalid config
  middleware/
    auth.ts                   -- verifies Supabase JWT, attaches req.userId
    internalAuth.ts           -- verifies X-Internal-Job-Secret for /internal/* routes only
    errorHandler.ts           -- central error -> HTTP response translation (last in the chain)
  routes/                     -- HTTP layer only: parse request, call one service function, shape response
    subscriptions.ts
    paymentMethods.ts
    analytics.ts
    internalJobs.ts
  schemas/                    -- request/response validation schemas (e.g. Zod), shared by routes and tests
  services/                   -- business logic; the ONLY layer allowed to call more than one repository
    subscriptionService.ts    --   or wrap a multi-write transaction
    paymentMethodService.ts
    analyticsService.ts
    notificationService.ts    -- wraps Resend + the notification_log dedup/transaction pattern
  repositories/                -- the ONLY place raw queries exist (the enforced repository layer)
    subscriptionRepository.ts
    billingRepository.ts
    paymentMethodRepository.ts
    notificationLogRepository.ts
  jobs/                        -- logic invoked by the internal job routes
    transitionOverdue.ts
    sendReminders.ts
    sendEscalations.ts
    sendMonthlySummary.ts
  db/
    pool.ts                    -- the single privileged Postgres connection pool
```

Import boundaries (enforceable with a lint rule, e.g. `eslint-plugin-boundaries`, once the project has a linter configured):
* Only `repositories/` may import `db/pool.ts`.
* Only `services/` and `jobs/` may call more than one repository function or open a transaction.
* `routes/` may only call `services/`, never `repositories/` directly.

This is the enforced-repository-layer decision (`database-design.md`) made concrete as folder structure, not just a convention to remember.

---

## Validation Rules

Consolidates every field's rule in one place; cross-referenced to the BR/FR it implements. All request bodies are **strict** (unknown fields rejected with `400`) — a mass-assignment guard, since an unrecognized field silently accepted is how a client-supplied `status` or `userId` sneaks past validation (SEC-003).

| Field | Rule | Reference |
| --- | --- | --- |
| `subscriptions.name` | required (create), 1–200 chars, non-empty after trim | — |
| `subscriptions.category` | required (create), free text, 1–100 chars | BR-016 |
| `subscriptions.cost` | required (create), numeric, `> 0`, ≤ 2 decimal places | BR-011 |
| `subscriptions.subscriptionType` | required (create), `recurring` \| `one_time` | BR-017 |
| `subscriptions.billingPeriod` | required if `recurring`, **must be absent** if `one_time` | BR-017 |
| `subscriptions.startDate` | required (create/reactivate), valid ISO date | BR-003 |
| `subscriptions.paymentMethodId` | required (create), must reference a payment method owned by the caller **and** currently active | FR-043, BR-019 |
| `subscriptions.renewalLink` / `cancellationLink` | optional; if present, must be a valid `http(s)` URL | — |
| `subscriptions.autoRenews` | required (create), boolean | BR-014 |
| `PATCH /subscriptions/:id` body | at least one field; `status`/`billingStatus` explicitly rejected (`400`), not silently dropped | FR-030 |
| `POST /:id/renew` body | `cost` optional (`> 0` if present), `paymentMethodId` optional (owned + active if present); `409` if subscription is `inactive` | FR-031 |
| `POST /:id/cancel` body | none; `409` if already `inactive` | FR-032 |
| `POST /:id/reactivate` body | `startDate` required; `cost`/`billingPeriod` optional (same rules as create); `409` if not currently `inactive` | FR-039, BR-013 |
| `paymentMethods.type` | required, `credit_card` \| `debit_card` \| `apple_pay` | BR-010 |
| `analytics` query (`from`/`to`) | optional, valid ISO dates, `from <= to` | FR-060 |
| `internal/jobs/*` | no body; `X-Internal-Job-Secret` header required | — |

---

## Error-Handling Strategy

A single error-handling middleware, last in the chain, is the only place that turns an error into an HTTP response — no route or service formats its own error response.

* **Expected errors** are thrown as typed classes (`ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`) carrying a safe, specific message — mapped to `400`/`404`/`409`/`401` respectively, and that message is what the client sees.
* **Anything else** (an unhandled exception — a bug, a DB connection drop, etc.) becomes a generic `500` with a fixed, non-descriptive message to the client. The full error (stack trace, query, context) is logged server-side only, tagged with a request-correlation id, and **never** serialized into the response — directly satisfies SEC-006 ("security-relevant failures must not expose sensitive implementation details").
* Raw database errors are never passed through as-is: a unique-constraint hit on `notification_log` is treated internally as "already sent, skip" (not surfaced as an error at all); an FK violation on `payment_method_id` becomes a clean `400`/`404`, not a leaked Postgres error string.

---

## Transaction Requirements

| Operation | What must be atomic | Why |
| --- | --- | --- |
| Create subscription | insert `subscriptions` row + insert first `billing` row | Never leave a subscription with zero billing rows — every downstream query assumes a "current cycle" always exists. |
| Confirm renewal | insert new `billing` row + update `subscriptions.status` | Both or neither — a status flip with no matching new cycle (or vice versa) breaks the state machine. |
| Reactivate | update `subscriptions` (status, optionally cost/billingPeriod) + insert new `billing` row | Same reasoning as create. |
| Confirm cancellation | single-statement update; transaction wrapping is trivial but harmless for consistency | Only one write involved. |
| `transition-overdue` job | one transaction **per subscription** (update `subscriptions.status` + `billing.status` together) — **not** one transaction for the whole daily batch | A bad/locked row shouldn't block or roll back every other subscription's transition that day. |
| Notification send (any job) | see below — has its own ordering requirement beyond plain atomicity | Resolves the PRD's open retry-policy question. |

**Notification send ordering:** insert into `notification_log` (`ON CONFLICT DO NOTHING RETURNING id`) inside a transaction *before* calling Resend.
* No row returned → already sent, skip, nothing else happens.
* Row returned → call Resend. **On success, commit** (the log entry persists). **On failure, roll back** the log insert, so the next scheduled run naturally retries it — no separate retry queue needed at this scale. A transient Resend outage means a reminder arrives up to a day late (the next daily run), which is an acceptable degradation for a personal-scale app rather than building retry/backoff infrastructure for it.

This resolves `prd.md`'s previously-`[TBD]` "email delivery fails (provider outage) — retry policy" edge case: **retry on the next scheduled job run, no in-process retry loop.**

---

## Notification Workflow (end-to-end)

Every one of the four internal job endpoints (`api-design.md`) follows the same shape:

1. Internal-secret check.
2. Repository query for candidates (e.g., `active` subscriptions where `dueDate - today ∈ {5,4,3,2,1}`).
3. For each candidate, the transactional dedup-then-send sequence above.
4. Endpoint returns a summary (`{ processed, sent, skipped, failed }`) — not consumed by any caller, just useful for logs/manual checks once observability tooling is chosen.

**Two more PRD edge cases resolved here, since they fall directly out of this workflow:**

* **Monthly summary when a user has zero subscriptions:** the `send-monthly-summary` job skips that user entirely (no `notification_log` row attempted, no email sent) rather than sending a "nothing to report" email. Resolves `prd.md`'s open question under Open Questions.
* **Renewal date lands on an invalid calendar date** (e.g., annual billing period starting Feb 29 in a leap year, next `dueDate` would be Feb 29 in a non-leap year): clamp to the last valid day of the target month (Feb 28) — the standard convention for calendar-period date arithmetic. Resolves the `[TBD]` in `prd.md`'s Error & Edge Cases.

---

## Roadmap Cross-Reference

Together with `database-design.md` and `api-design.md`, this closes out Phase 4: backend module structure, API contracts, request/response schemas, validation rules, error-handling strategy, database schema, indexes, transaction requirements, and notification workflow are all now defined.
