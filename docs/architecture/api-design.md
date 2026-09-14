# API Design

## Subscription Manager — REST Contracts

Translates `docs/product/prd.md` (v1.1) and `docs/architecture/database-design.md` into concrete endpoint contracts. All endpoints sit behind the enforced repository layer (`docs/architecture/decisions.md`, "Authorization Enforcement Strategy") — every handler resolves the authenticated user id from the verified token and passes it into repository calls; no handler queries the database directly.

---

## Conventions

* Base path: `/api/v1`.
* Content type: `application/json` for all requests/responses.
* **Auth:** every endpoint except `/internal/*` requires `Authorization: Bearer <Supabase access token>`. The API verifies the token's signature and expiry and extracts the user id (`sub` claim) — this is the only source of truth for "who is making this request" (FR-004/FR-005); it is never taken from the request body.
* **Ownership failures return 404, not 403.** Requesting a resource that exists but belongs to another user returns the same `404` as a resource that doesn't exist at all, so responses never confirm or deny another user's data exists (avoids resource-enumeration information disclosure).
* **Error envelope:**
  ```json
  { "error": { "code": "VALIDATION_ERROR", "message": "cost must be greater than 0", "field": "cost" } }
  ```
  Status codes used: `400` (validation), `401` (missing/invalid token), `404` (not found / not owned), `409` (conflict, e.g. reactivating a subscription that isn't `inactive`), `500` (unexpected).
* Timestamps: ISO 8601 UTC. Dates (`startDate`, `dueDate`): `YYYY-MM-DD`.
* No endpoint ever accepts or returns a `status` or `billingStatus` field directly editable by the client outside the dedicated action endpoints below — matches FR-030 ("editing does not touch status").

---

## Payment Methods

### `POST /api/v1/payment-methods`
Create a payment method (FR-041).

Request:
```json
{ "type": "credit_card" }
```
`type` ∈ `credit_card` \| `debit_card` \| `apple_pay` (400 if not).

Response `201`:
```json
{ "id": "uuid", "type": "credit_card", "isActive": true, "createdAt": "..." }
```

### `GET /api/v1/payment-methods?activeOnly=true`
List the caller's payment methods (default `activeOnly=true`; pass `false` to include soft-deleted ones, e.g. to render historical billing entries correctly).

Response `200`: array of the same shape as above.

### `POST /api/v1/payment-methods/:id/deactivate`
Soft-delete (FR-042, BR-019). Does not touch subscriptions/billing rows referencing it.

Response `200`: `{ "id": "uuid", "type": "credit_card", "isActive": false, "updatedAt": "..." }`
`404` if not found/not owned. Deactivating an already-inactive method is a no-op `200`, not an error.

---

## Subscriptions

### `POST /api/v1/subscriptions`
Create (FR-010/011/012/013). Requires at least one active payment method to exist first (FR-043).

Request:
```json
{
  "name": "Netflix",
  "category": "Entertainment",
  "subscriptionType": "recurring",
  "billingPeriod": "monthly",
  "startDate": "2026-09-08",
  "cost": 15.49,
  "paymentMethodId": "uuid",
  "renewalLink": "https://...",
  "cancellationLink": "https://...",
  "autoRenews": true
}
```

Validation (400 on failure):
* `cost` > 0 (BR-011).
* `billingPeriod` required if `subscriptionType = recurring`; must be **absent** if `subscriptionType = one_time` (BR-017) — this is the explicit user confirmation of "one-time" the PRD requires, there's no separate confirmation flag.
* `paymentMethodId` must belong to the caller and be active.

Response `201`: the created subscription (see `GET /:id` shape below), `status: "active"`. Creates the first `billing` row internally (paid, due at `startDate + billingPeriod`) and queues a "subscription created" email (FR-013) — both are side effects, not part of the response body.

### `GET /api/v1/subscriptions?status=active`
List, filtered by status (FR-020, Story 3). `status` ∈ `active` \| `active-unknown` \| `inactive`, required.

Response `200`:
```json
[
  {
    "id": "uuid",
    "name": "Netflix",
    "category": "Entertainment",
    "cost": 15.49,
    "billingPeriod": "monthly",
    "subscriptionType": "recurring",
    "status": "active",
    "autoRenews": true,
    "paymentMethod": { "id": "uuid", "type": "credit_card" },
    "currentCycle": { "dueDate": "2026-10-08", "status": "paid" }
  }
]
```
Sort order: `active` → soonest `currentCycle.dueDate` first; `inactive` → alphabetical by `name` (Story 3). `active-unknown` → soonest-overdue first (oldest lapsed `dueDate` first, since that's the most urgent to reconcile).

### `GET /api/v1/subscriptions/:id`
Full detail (FR-021). Same shape as the list item, plus `renewalLink`, `cancellationLink`, `startDate`, `createdAt`, `updatedAt`. `404` if not found/not owned.

### `PATCH /api/v1/subscriptions/:id`
Plain field edits only (FR-030). Never accepts `status`.

Request (all optional): `{ "name", "category", "cost", "billingPeriod", "renewalLink", "cancellationLink", "autoRenews", "paymentMethodId" }`

Response `200`: updated subscription. `400` if the request body includes `status` or `billingStatus` (rejected outright, not silently ignored — makes the "this endpoint can't change status" rule visible to API consumers instead of failing silently).

### `POST /api/v1/subscriptions/:id/renew`
Confirm a renewal (FR-031, Story 6). Valid from `active` (early renewal, per the PRD's edge case) or `active-unknown`.

Request (all optional): `{ "cost": 16.99, "paymentMethodId": "uuid" }`

Response `200`: updated subscription with `status: "active"` and the new `currentCycle`. Creates a new `billing` row (paid); the prior row, even if lapsed, is untouched (BR-005). Sends a status-change email (FR-034) **only if `status` actually changed** — i.e., not for an early renewal confirmed while already `active`. `409` if subscription is `inactive` (renew doesn't apply — use `/reactivate` instead).

### `POST /api/v1/subscriptions/:id/cancel`
Confirm a cancellation (FR-032, Story 7). Valid from `active` or `active-unknown`.

Request: `{}` (no body).

Response `200`: `{ ..., "status": "inactive" }`. No new `billing` row. Sends a status-change email. `409` if already `inactive`.

### `POST /api/v1/subscriptions/:id/reactivate`
Reactivate an `inactive` subscription (FR-039, Story 11). `409` if not currently `inactive`.

Request:
```json
{ "startDate": "2026-09-08", "cost": 16.99, "billingPeriod": "monthly" }
```
`cost`/`billingPeriod` optional — omit to reuse the subscription's existing values; `startDate` always required (BR-013).

Response `200`: updated subscription, `status: "active"`, reusing `name`/`category`/`paymentMethodId`/links/`autoRenews` from the existing record. Creates a new `billing` row. Sends a status-change email.

### `GET /api/v1/subscriptions/:id/billing-history?from=&to=`
Full ledger for one subscription (FR-047). `from`/`to` optional date filters.

Response `200`:
```json
[
  { "transactionId": "uuid", "amount": 15.49, "status": "paid", "dueDate": "2026-09-08", "paymentMethod": { "id": "uuid", "type": "credit_card" }, "createdAt": "..." }
]
```
Ordered newest-first.

No `DELETE` endpoint anywhere in this resource — matches FR-040/BR-009.

---

## Analytics

### `GET /api/v1/analytics/spending?from=&to=`
Combined analytics payload (FR-060–063, Story 9) — one endpoint rather than four, since the dashboard needs all of it together and none of it is expensive to compute alongside the rest.

Response `200`:
```json
{
  "range": { "from": "2026-01-01", "to": "2026-12-31" },
  "totalNormalizedMonthlySpend": 142.30,
  "byCategory": [ { "category": "Entertainment", "monthlySpend": 42.30 } ],
  "bySubscriptionType": { "recurring": { "count": 8, "monthlySpend": 142.30 }, "oneTime": { "count": 2, "totalSpend": 60.00 } },
  "statusBreakdown": { "active": 8, "activeUnknown": 1, "inactive": 3 },
  "pendingReconciliation": [ { "id": "uuid", "name": "Spotify", "lapsedSince": "2026-09-01" } ]
}
```
`pendingReconciliation` exists so `active-unknown` subscriptions are called out explicitly rather than silently folded into totals (Story 9's requirement). Spend figures are computed from the `billing` ledger (actual per-cycle `amount`s), not `subscriptions.price`, so historical accuracy survives price changes.

---

## Internal — Scheduled Jobs

Called only by Supabase Cron (`pg_cron`/`pg_net`), never by the frontend. Authenticated by a shared secret, **not** a user's Supabase JWT:

```text
X-Internal-Job-Secret: <shared secret, compared against an env var>
```
`401` if missing/incorrect. These routes are excluded from the normal user-auth middleware entirely — they're a structurally separate path, not "an endpoint most users can't reach."

Four separate endpoints (one job each), each with its own `pg_cron` schedule entry — kept granular rather than one combined "run everything" endpoint so a failure in one doesn't block or obscure the others, and each can be checked, logged, and retried independently.

### `POST /api/v1/internal/jobs/transition-overdue`
*Daily.* Implements BR-006/FR-033/FR-045: finds every `active` subscription whose current `billing` row is `paid` with a `due_date` on or before today, flips that row to `due` (`markCycleOverdue`), and sets the subscription's `status` to `active-unknown`. Sends the resulting status-change emails (deduped via `notification_log`, type `status_changed`).

### `POST /api/v1/internal/jobs/send-reminders`
*Daily.* Implements FR-050. For every `active` subscription, checks its current cycle's `due_date` against today; if the gap is exactly 5, 4, 3, 2, or 1 day(s), sends the reminder email — guarded by `notification_log` (`dedup_key = "reminder:{offset}:{dueDate}"`) so a same-day retry can't double-send (FR-051).

### `POST /api/v1/internal/jobs/send-escalations`
*Daily.* Implements FR-053/BR-018. For every `active-unknown` subscription, checks days elapsed since the initial lapse (or the last escalation send) against the 3-day cadence; sends if due, guarded by `notification_log` (`dedup_key` includes the date) to survive retries.

### `POST /api/v1/internal/jobs/send-monthly-summary`
*Monthly, 1st of the month* (the `pg_cron` schedule itself is `0 0 1 * *` — the endpoint doesn't need to re-check the date). Implements FR-052. For every user, computes the same analytics payload as `GET /analytics/spending` scoped to the past month and emails it, guarded by `notification_log` (`dedup_key = "monthly:{year-month}"`, `subscription_id = null`).
