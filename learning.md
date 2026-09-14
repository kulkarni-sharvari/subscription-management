# Learning Log

Quick-recap notes on concepts learned while building this project. Newest entries at the bottom.

---

## Phase 5 — Backend Scaffolding

### Stack decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| ORM | Prisma | Easiest on-ramp for learning TS; huge docs/community. Custom triggers/CHECK constraints (already hand-written in `database-design.md`) get added as raw SQL inside Prisma migrations, since its schema DSL can't express them natively. |
| Backend framework | Express | Most tutorials/ecosystem; simple mental model. Paired with Zod for validation since Express has no built-in schema validation (unlike Fastify). |
| Repo layout | Monorepo (`app/api`, `app/web`) via npm workspaces | Easier to share TS types between frontend and backend later; one place for CI. |
| Validation | Zod | De facto TS validation standard — infers static types from schemas so a shape is defined once, not duplicated between a validator and a type. |

### Git — why `git init` and `.gitignore` come first

- `git init` before anything else so every scaffolding step is tracked from the start.
- `.gitignore` created **before** any dependency install or `.env` file exists. The critical line is `.env*` — if that's missing even once and a secret gets committed, it's in git history permanently (hard/unreliable to scrub later). Getting the ignore rule in place *before* the first secret-bearing file exists avoids the problem entirely rather than cleaning it up after.
- Other standard ignores: `node_modules/` (regenerable from `package.json`, huge), `dist/`/`build/` (compiled output, not source), `*.log`, `.DS_Store` (macOS Finder noise).

### npm workspaces — monorepo mechanics

- A **monorepo** is one git repo containing multiple sub-projects. npm's **workspaces** feature is what makes npm aware of them as a group.
- Root `package.json` doesn't hold real app dependencies — its job is just orchestration:
  ```json
  {
    "name": "subscription-management",
    "private": true,
    "version": "1.0.0",
    "workspaces": ["app/*"]
  }
  ```
- `"private": true` hard-blocks `npm publish` — prevents ever accidentally publishing the whole codebase to the public npm registry.
- `"workspaces": ["app/*"]` tells npm: any folder under `app/` with its own `package.json` is a workspace member. Once that's true, running `npm install` from the repo root installs *all* workspaces' dependencies into one shared, deduplicated root `node_modules` — no need to `cd` into each app separately. (The folder is named `app`, singular, in this project — the workspaces glob just has to match whatever the folder is actually called.)
- Extra default fields npm's `init -y` adds (`description`, `directories`, `author`, `license`, `type`) are harmless at the root — nothing ever executes code from the root `package.json` directly, so they're inert.

### CommonJS vs ES Modules (`"type"` field in `package.json`)

- `"type": "commonjs"` (npm's default) → old Node module system: `require()` / `module.exports`.
- `"type": "module"` → ES Modules (ESM), the modern JS standard: `import` / `export`, same syntax used in browsers.
- Chose **ESM (`"type": "module"`)** for `apps/api` — it's the direction the whole JS ecosystem has moved, and TypeScript's `import`/`export` syntax maps onto it directly without CommonJS interop quirks.

### `tsconfig.json` — `target` vs `module` vs `moduleResolution`

Three separate compiler settings, easy to conflate since they sit in the same options block:

- **`target`** — which *JS language version* the compiler emits (downlevels modern syntax like optional chaining/class fields into older equivalents, or leaves it as-is if the target already supports it). Chose `ES2022` since we control the Node version running our own backend (unlike a browser, where you don't control the user's engine) — no need to downlevel.
- **`module`** — which *module system* the output actually uses: `require`/`module.exports` (CommonJS) vs `import`/`export` (ESM). A genuinely different axis from `target`. Set to `NodeNext`, which compiles modules the way Node itself actually interprets them (per-file, based on `package.json`'s `"type"` field) — since `"type": "module"` is set, this emits real ESM.
- **`moduleResolution`** — the *algorithm* TypeScript uses to find the real file behind an import and its type definitions. Must be paired with `"module": "NodeNext"` (TS enforces this) since it mimics Node's actual ESM resolution rules rather than a generic node_modules search.

**Practical gotcha this introduces:** under real Node ESM / `NodeNext` resolution, relative imports need an explicit file extension — even from a `.ts` file, you write:
```ts
import { getUser } from "./user.js";   // .js, not .ts — refers to the compiled output
```
not extensionless `./user`. Trips up anyone coming from CommonJS or a bundler (Vite/webpack) background where extensionless imports are normal.

### Running TypeScript in dev vs. production

- **Dev**: `tsx watch src/index.ts` — compiles/runs `.ts` directly in-memory and auto-restarts on file changes (same category of tool as `nodemon`, but TypeScript-aware). Fast edit → run → see-result loop; never used in production.
- **Prod**: `tsc` (via `npm run build`) compiles every `.ts` in `src/` to plain `.js` in `dist/` (per `tsconfig.json`'s `rootDir`/`outDir`), then `node dist/index.js` (`npm start`) runs the compiled output with plain Node — no TypeScript tooling involved at runtime at all. This is what a hosting platform/CI would actually run.
- Both were verified working end-to-end on the same minimal Express server (`GET /health`) before moving on.

### `.env` vs `.env.example`

- `.env` — the real file, holding actual secret values (DB connection string, API keys). Already covered by the `.gitignore` rule added on day one, so it's never committed — this is *why* that rule was written before any `.env` file existed.
- `.env.example` — a **committed** template listing every variable name the app needs, with placeholder/blank values, no real secrets. Lets anyone (including future-you, or a fresh clone) know what `.env` must contain without ever exposing a real value.
- Before ever running `git add`, it's worth re-running `git status` and confirming `.env` doesn't appear anywhere in the output (staged or untracked) — a quick, cheap sanity check that the ignore rule is actually working, not just assumed.
- `dotenv` (to load `.env` into `process.env`) and `zod` (to validate that `process.env` actually has everything required, with the right shapes, and fail fast at startup if not) are the two packages planned for this — installed but not yet wired up as of this note.

### Practical gotcha: absolute vs. relative paths

- `mkdir apps/api` (relative) creates the folder **inside whatever directory the terminal is currently in**.
- `mkdir /app/api` (leading `/`) means "starting from the filesystem root" — a completely different, unrelated location. This one failed because `/app` doesn't exist at the filesystem root.
- A typo along the way (`app` vs `apps`) produced a folder actually named `app` (singular) instead of the originally planned `apps`. Resolution: rather than renaming the folder, the root `package.json`'s `"workspaces"` field was updated to match the folder that actually exists (`"app/*"`). Either fix works — what matters is that the workspaces glob and the real folder name agree. Always double check `pwd` before relative commands, and `ls` after creating directories, to confirm the result matches intent before moving forward.
