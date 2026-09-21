# Subscription Manager

> A full-stack subscription management application that helps users track recurring subscriptions, understand their spending, and avoid unwanted renewals.

**Status:** In Development

**Purpose:** Personal application + Full-Stack & Application Security portfolio project

***

## Overview

Subscription Manager is a web application designed to help users manage recurring subscriptions in one place.

The idea came from a simple problem: subscribing to a service for a short period of time, knowing that I would likely cancel it after a few months, and then creating a separate reminder to remember to cancel it before the next billing cycle.

After experiencing this repeatedly across different services, I wanted a single application that could:

* Keep track of active and inactive subscriptions
* Track upcoming renewal dates
* Notify users before subscriptions renew
* Provide visibility into recurring spending
* Help users make informed decisions about their subscriptions

The application is also being developed as a portfolio project to demonstrate the complete software development lifecycle, including **product design, UX, system design, full-stack implementation, testing, application security, CI/CD, deployment, and operational considerations**.

***

# Project Goals

## Product Goals

* Centralize subscription information
* Make upcoming renewals easy to identify
* Help users understand recurring spending
* Reduce accidental subscription renewals
* Provide useful spending insights

## Engineering Goals

* Build a complete full-stack application
* Practice modular software architecture
* Design maintainable APIs and data models
* Apply automated testing throughout development
* Implement CI/CD
* Practice secure software development
* Document architectural decisions and trade-offs
* Design for maintainability rather than unnecessary complexity

## Application Security Goals

Security will be treated as a first-class engineering requirement.

The project will incorporate:

* Threat modeling
* Secure authentication
* Server-side authorization
* Input validation
* API security
* Secure secrets management
* Security headers
* SAST
* DAST
* Dependency scanning
* Secret scanning
* Security-focused testing
* Security requirements derived from identified threats

***

# Product Scope

## V1 — Current Scope

### Authentication

Users will be able to:

* Register
* Log in
* Log out
* Access authenticated application functionality

Authentication implementation:

`[TBD — architecture evaluation]`

### Subscription Management

Users will be able to:

1. Add a subscription
2. View all subscriptions
3. Search/filter subscriptions
4. View subscription details
5. Edit subscription details
6. Cancel/deactivate a subscription
7. Reactivate an inactive subscription

### Renewal Tracking

The application will track:

* Subscription name
* Cost
* Currency
* Billing frequency
* Start date
* Next renewal date
* Subscription status

Users will receive reminders before a subscription renews.

Initial reminder schedule:

* 5 days before renewal
* 3 days before renewal
* 2 days before renewal
* 1 day before renewal

Reminder schedule customization:

`[TBD]`

### Spending Analytics

Users will be able to view subscription spending information such as:

* Monthly spending
* Annualized spending
* Spending by category
* Upcoming subscription charges
* Active vs inactive subscriptions

Additional analytics:

`[TBD]`

***

# Future Scope

Future features will be evaluated based on user value, implementation complexity, privacy implications, security risk, and operational cost.

## Automated Subscription Discovery

### Email Integration

Users may be able to connect an email account to automatically identify subscription-related emails.

Potential functionality:

* Detect subscription confirmation emails
* Identify service names
* Extract billing amounts
* Extract billing frequency
* Extract renewal dates
* Ask the user to confirm extracted information

> This feature will require additional security and privacy analysis because it introduces access to potentially sensitive email data.

Status: `Future`

### Receipt / Invoice Processing

Potential functionality:

* Upload invoices or receipts
* Extract subscription information
* Allow users to review extracted information
* Require confirmation before creating a subscription

Status: `Future`

***

## Spending Intelligence

Potential features:

* Spending trends
* Subscription cost forecasting
* Unusual spending detection
* Subscription usage insights
* Alternative service recommendations

Status: `Future`

***

## Personalization

Potential features:

* Custom reminder schedules
* Custom subscription categories
* Tags
* Spending limits
* Dashboard customization
* Multiple currencies

Status: `Future`

***

## Security Enhancements

Potential future features:

* Multi-factor authentication
* Passkeys / WebAuthn
* Login anomaly detection
* Device/session management
* Security event audit logs
* More granular authorization
* Automated security regression testing

Status: `Future`

***

# User Flow

The primary V1 workflow is:

```text
                    Login
                      │
                      ▼
                  Dashboard
                      │
                      ▼
               Add Subscription
                      │
                      ▼
             Subscription Stored
                      │
                      ▼
              Renewal Approaches
                      │
                      ▼
              Reminder Notification
                      │
              ┌───────┴────────┐
              ▼                ▼
          Continue           Cancel
              │                │
              ▼                ▼
        Active Status       Inactive Status
```

***

# Technology Stack

The following technologies have been selected as part of the initial architecture direction.

## Frontend

* **React** (plain SPA — no meta-framework such as Next.js)
* **TypeScript**
* **Tailwind CSS**

Decided over Next.js: this project deliberately keeps the frontend as a separate client talking to its own REST API, rather than folding the API layer into a frontend meta-framework, so the backend REST API remains a distinct piece of engineering work in its own right (see [Decision Log](#decision-log)).

## Backend

* **Node.js** — a separate backend service, decoupled from the frontend.

The backend will expose a **REST API**.

## Database

* **PostgreSQL**, hosted on **Supabase**

## Authentication

* **Supabase Auth**, using the same Supabase project as the database.

## Testing

Planned testing layers:

* Unit testing
* Integration/API testing
* End-to-end testing
* Security testing

Testing frameworks:

`[TBD]`

## DevOps

Planned tooling:

* Git
* GitHub
* GitHub Actions
* Docker

Cloud/deployment provider:

`[TBD — free/student-friendly option]`

## Security Tooling

Planned security practices/tools:

* OWASP ASVS
* OWASP Top 10
* STRIDE threat modeling
* SAST
* DAST
* Dependency scanning
* Secret scanning

Specific tools:

`[TBD]`

***

# Architecture Principles

The following principles are currently frozen:

1. The application will use a **modular monolith** architecture.
2. **TypeScript** will be used across the application.
3. **REST** will be the primary API style.
4. User-owned resources must enforce **server-side authorization**.
5. Input validation will occur at **trust boundaries**.
6. Established security primitives will be preferred over custom security implementations.
7. Secrets must never be committed to source control.
8. Automated testing will be part of the development workflow.
9. Security testing will be integrated into CI/CD.
10. Infrastructure and architectural complexity must be justified by a real requirement.

The following decisions remain intentionally open until the technical design is completed:

* Hosting/deployment architecture (frontend and Node.js API — the database and auth are already hosted via Supabase)
* Observability tooling

***

# Security Principles

Security requirements will be derived from the application's architecture and threat model.

Core principles include:

### Server-Side Authorization

Authentication alone is not sufficient.

Every user-owned resource must be authorized on the server.

For example:

```text
Authenticated User
        │
        ▼
GET /api/v1/subscriptions/:id
        │
        ▼
Is subscription owned by user?
        │
    ┌───┴───┐
    │       │
   Yes      No
    │       │
    ▼       ▼
Return    Reject
Data      Request
```

### Input Validation

External input will be validated before reaching business logic or persistence layers.

```text
Client
  │
  ▼
API
  │
  ▼
Validation
  │
  ▼
Business Logic
  │
  ▼
Data Access
  │
  ▼
Database
```

### Least Privilege

The application and its supporting services should operate with only the permissions required to perform their functions.

### Secure Defaults

Security-sensitive functionality should use secure defaults rather than relying on developers or users to explicitly enable security controls.

### Secrets Management

Secrets must:

* Never be committed to Git
* Never be hardcoded
* Never be exposed to the browser unnecessarily
* Never be logged
* Be provided through environment configuration or a managed secrets mechanism

***

# API

The application will use REST APIs.

The API versioning strategy will initially use:

```text
/api/v1/
```

Planned resources:

```text
/api/v1/subscriptions
/api/v1/analytics
/api/v1/notifications
```

Login, logout, and registration are handled by Supabase Auth directly from the frontend and are **not** Node.js API endpoints — the API's role is verifying the resulting token on every request, not issuing or managing sessions itself.

Example endpoints:

```text
GET    /api/v1/subscriptions
POST   /api/v1/subscriptions
GET    /api/v1/subscriptions/:id
PATCH  /api/v1/subscriptions/:id
DELETE /api/v1/subscriptions/:id

GET    /api/v1/analytics/spending

GET    /api/v1/notifications/preferences
PATCH  /api/v1/notifications/preferences
```

API specification:

`[TBD — OpenAPI/Swagger]`

***

# Domain Model

The initial domain model is expected to contain:

```text
User
 │
 ├── Subscription
 │       │
 │       └── Category
 │
 └── NotificationPreference
```

Potential future entities:

```text
Notification
SubscriptionEvent
AuditLog
```

The final domain model will be determined during the requirements and system-design phase.

***

# Documentation

The repository will contain engineering documentation covering the complete development lifecycle.

```text
docs/
│
├── product/
│   ├── PRD.md
│   ├── user-stories.md
│   └── user-flows.md
│
├── design/
│   ├── ux-prototype.md
│   └── accessibility.md
│
├── architecture/
│   ├── architecture-principles.md
│   ├── system-design.md
│   ├── high-level-design.md
│   ├── low-level-design.md
│   ├── api-design.md
│   ├── database-design.md
│   └── adr/
│
├── security/
│   ├── threat-model.md
│   ├── security-requirements.md
│   ├── authentication.md
│   ├── authorization.md
│   ├── api-security.md
│   ├── data-protection.md
│   ├── security-testing.md
│   ├── vulnerability-management.md
│   ├── risk-register.md
│   └── incident-response.md
│
├── development/
│   ├── setup.md
│   ├── coding-standards.md
│   ├── testing.md
│   └── ci-cd.md
│
└── operations/
    ├── deployment.md
    ├── observability.md
    ├── backup-recovery.md
    └── disaster-recovery.md
```

***

# Development Workflow

The project will follow a design-first workflow.

```text
Product Requirements
        ↓
User Stories
        ↓
UX / User Flows
        ↓
Domain Model
        ↓
Architecture Evaluation
        ↓
High-Level Design
        ↓
Threat Model
        ↓
Low-Level Design
        ↓
API + Database Design
        ↓
Implementation
        ↓
Testing
        ↓
Security Testing
        ↓
CI/CD
        ↓
Deployment
        ↓
Observability
        ↓
Security Review
```

***

# Quality & Security Gates

A feature should not be considered complete merely because it works.

A feature should pass:

```text
Functional Requirements
        +
Code Review
        +
Automated Tests
        +
Security Requirements
        +
Security Tests
        +
CI Checks
```

before being considered complete.

***

# Development Roadmap

## Phase 0 — Product & Requirements

* \[X] Define V1 scope
* \[X] Write PRD
* \[ ] Define user stories
* \[ ] Define acceptance criteria
* \[ ] Define functional requirements
* \[ ] Define non-functional requirements

## Phase 1 — UX & Domain Design

* \[ ] Create user flows
* \[ ] Create wireframes
* \[ ] Create UX prototype
* \[X] Define domain entities — `docs/architecture/data-model.md` (User, Subscription, Billing, PaymentMethod)
* \[X] Define entity relationships — FKs documented in `data-model.md`
* \[X] Define subscription lifecycle/state transitions — `docs/product/prd.md` (state machine), `data-model.md`

## Phase 2 — Architecture

* \[X] Evaluate Node.js vs Next.js API — decided: Node.js, kept separate from the frontend
* \[X] Evaluate PostgreSQL vs alternatives — decided: PostgreSQL
* \[X] Define system boundaries — `docs/architecture/high-level-design.md`
* \[X] Create HLD — `docs/architecture/high-level-design.md`
* \[X] Define API architecture — `docs/architecture/api-design.md`
* \[X] Define database architecture — `docs/architecture/database-design.md`
* \[X] Define background job requirements — Supabase Cron → Node API (`docs/architecture/decisions.md`)
* \[X] Define notification architecture — Resend (`docs/architecture/decisions.md`)
* \[ ] Document major decisions as ADRs — `docs/architecture/decisions.md` is currently a running Q\&A log, not yet split into formal per-decision ADR files

## Phase 3 — Application Security Design

* \[ ] Identify trust boundaries
* \[ ] Create threat model
* \[ ] Identify threats
* \[ ] Assign risk levels
* \[ ] Define security requirements
* \[ ] Define authentication approach
* \[ ] Define authorization model
* \[ ] Define data protection requirements
* \[ ] Define security testing strategy

## Phase 4 — Low-Level Design

* \[X] Define backend module structure — `docs/architecture/low-level-design.md`
* \[X] Define API contracts — `docs/architecture/api-design.md`
* \[X] Define request/response schemas — `docs/architecture/api-design.md`, `docs/architecture/low-level-design.md`
* \[X] Define validation rules — `docs/architecture/low-level-design.md`
* \[X] Define error-handling strategy — `docs/architecture/low-level-design.md`
* \[X] Define database schema — `docs/architecture/database-design.md`
* \[X] Define indexes — `docs/architecture/database-design.md`
* \[X] Define transaction requirements — `docs/architecture/low-level-design.md`
* \[X] Define notification workflow — `docs/architecture/low-level-design.md`

## Phase 5 — Implementation

* \[ ] Project setup
* \[ ] Authentication
* \[ ] Subscription management
* \[ ] Dashboard
* \[ ] Analytics
* \[ ] Notifications
* \[ ] Notification preferences

## Phase 6 — Testing

* \[ ] Unit tests
* \[ ] Integration tests
* \[ ] API tests
* \[ ] E2E tests
* \[ ] Security tests
* \[ ] Performance testing
* \[ ] Accessibility testing

## Phase 7 — CI/CD & Security Automation

* \[ ] GitHub Actions
* \[ ] Linting
* \[ ] Type checking
* \[ ] Unit/integration tests
* \[ ] SAST
* \[ ] Dependency scanning
* \[ ] Secret scanning
* \[ ] Build
* \[ ] E2E testing
* \[ ] DAST

## Phase 8 — Deployment & Operations

* \[ ] Select free/student-friendly hosting
* \[ ] Deployment architecture
* \[ ] Environment configuration
* \[ ] Secrets management
* \[ ] Logging
* \[ ] Monitoring
* \[ ] Backups
* \[ ] Recovery procedures
* \[ ] Disaster recovery documentation

***

# Decision Log

Important architectural decisions will be recorded using Architecture Decision Records (ADRs).

Current decisions:

| Decision                                    | Status    |
| ------------------------------------------- | --------- |
| Modular monolith                            | Decided |
| TypeScript                                  |Decided |
| React frontend (plain SPA, no meta-framework) |Decided |
| Tailwind CSS                                |Decided |
| Backend: Node.js (separate from frontend)   |Decided |
| Database: PostgreSQL (via Supabase)          |Decided |
| Authentication: Supabase Auth                |Decided |
| REST API                                    |Decided |
| Server-side authorization                   |Decided |
| Boundary input validation                   |Decided |
| Established security primitives             |Decided |
| Secrets management principles               |Decided |
| Automated testing                           |Decided |
| Security testing in CI/CD                   |Decided |
| Avoid unnecessary infrastructure complexity |Decided |
| Notification provider: Resend                |Decided |
| Background job mechanism: Supabase Cron (`pg_cron`/`pg_net`) → Node API endpoint |Decided |
| Hosting provider                            | Pending |
| Observability tooling                       |Pending |

***

# Screenshots & Demo

Screenshots and a live demo will be added as the application develops.

### Dashboard

`[Screenshot TBD]`

### Subscription Details

`[Screenshot TBD]`

### Spending Analytics

`[Screenshot TBD]`

### UX Prototype

`[Link TBD]`

### Live Demo

`[URL TBD]`

***

# Testing

Testing documentation will be maintained in:

`docs/development/testing.md`

The project will use multiple testing levels:

* Unit testing
* Integration/API testing
* End-to-end testing
* Security testing
* Regression testing

Coverage target:

`[TBD]`

***

# Deployment

Deployment platform:

`[TBD — free/student-friendly option]`

Environment strategy:

`[TBD]`

Deployment documentation:

`docs/operations/deployment.md`

***

# Credits

External libraries, frameworks, tutorials, documentation, and other resources used during development will be credited here.

***

# License

License:

`[TBD]`

This project is primarily intended as a personal application, learning project, and software engineering/application security portfolio project.
